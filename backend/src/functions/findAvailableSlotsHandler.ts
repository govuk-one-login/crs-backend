import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageBatchCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Readable } from 'stream';
import { Context } from 'aws-lambda';
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

// Define types for configuration
interface StatusListEntry {
  created: string;
  uri: string;
  maxIndices: number;
  format: string;
}

interface ListConfiguration {
  bitstringStatusList: StatusListEntry[];
  tokenStatusList: StatusListEntry[];
}

interface EndpointIndexPair {
  uri: string;
  idx: number;
}

enum QueueType {
  Bitstring = 'Bitstring',
  TokenStatus = 'TokenStatus'
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

interface QueueStatus {
  currentDepth: number;
  neededMessages: number;
}

// SQS queue URLs
const BITSTRING_QUEUE_URL = process.env.BITSTRING_QUEUE_URL || '';
const TOKEN_STATUS_QUEUE_URL = process.env.TOKEN_STATUS_QUEUE_URL || '';

// S3 bucket and configuration file path
const CONFIG_BUCKET = process.env.LIST_CONFIGURATION_BUCKET || '';
const CONFIG_KEY = process.env.CONFIGURATION_FILE_KEY || 'ListConfiguration.json';

// Target queue depth - how many messages we want to maintain in each queue
const TARGET_QUEUE_DEPTH = parseInt(process.env.TARGET_QUEUE_DEPTH || '10000', 10);

/**
 * Set up the logger with the current context
 */
function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

/**
 * Get the current number of messages in a queue
 */
async function getQueueDepth(queueUrl: string): Promise<number> {
  console.log(`Getting attributes for queue: ${queueUrl}`);
  try {
    const command = new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages']
    });

    const response = await sqsClient.send(command);
    const messageCount = parseInt(response.Attributes?.ApproximateNumberOfMessages || '0', 10);
    console.log(`Queue ${queueUrl} has approximately ${messageCount} messages`);
    return messageCount;
  } catch (error) {
    console.error(`Error getting queue attributes for ${queueUrl}:`, error);

    return 0;
  }
}

/**
 * Calculate how many messages to add to each queue
 */
async function calculateQueueRefills(): Promise<Record<QueueType, QueueStatus>> {
  // Get current queue depths
  const bitstringDepth = await getQueueDepth(BITSTRING_QUEUE_URL);
  const tokenStatusDepth = await getQueueDepth(TOKEN_STATUS_QUEUE_URL);

  // Calculate how many messages we need to add to reach the target
  const bitstringNeeded = Math.max(0, TARGET_QUEUE_DEPTH - bitstringDepth);
  const tokenStatusNeeded = Math.max(0, TARGET_QUEUE_DEPTH - tokenStatusDepth);

  console.log(`Bitstring queue: ${bitstringDepth} messages, need to add ${bitstringNeeded}`);
  console.log(`Token Status queue: ${tokenStatusDepth} messages, need to add ${tokenStatusNeeded}`);

  return {
    [QueueType.Bitstring]: {
      currentDepth: bitstringDepth,
      neededMessages: bitstringNeeded
    },
    [QueueType.TokenStatus]: {
      currentDepth: tokenStatusDepth,
      neededMessages: tokenStatusNeeded
    }
  };
}

/**
 * Fetch the configuration from S3
 */
async function getConfiguration(): Promise<ListConfiguration> {
  console.log('Fetching configuration from S3...');
  console.log(`Bucket: ${CONFIG_BUCKET}, Key: ${CONFIG_KEY}`);
  try {
    const command = new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key: CONFIG_KEY
    });

    const response = await s3Client.send(command);
    const bodyText = await streamToString(response.Body as Readable);
    console.log(`Fetched configuration: ${bodyText}`);
    return JSON.parse(bodyText) as ListConfiguration;
  } catch (error) {
    console.error('Error fetching configuration from S3:', error);
    throw error;
  }
}

/**
 * Convert a readable stream to string
 */
async function streamToString(stream: Readable): Promise<string> {
  console.log('Converting stream to string...');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  console.log('Stream converted to string successfully');
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Select random indexes for each endpoint
 */
function selectRandomIndexes(endpoints: string[], totalIndexes: number, maxIndexPerEndpoint: number): EndpointIndexPair[] {
  console.log('Selecting random indexes for endpoints...');

  const result: EndpointIndexPair[] = [];
  const indexesPerEndpoint = Math.ceil(totalIndexes / Math.min(totalIndexes, endpoints.length));

  for (const endpoint of endpoints) {
    const selectedIndexes = new Set<number>();
    while (selectedIndexes.size < indexesPerEndpoint) {
      const randomIndex = Math.floor(Math.random() * maxIndexPerEndpoint);
      selectedIndexes.add(randomIndex);
    }

    for (const idx of selectedIndexes) {
      result.push({ uri: endpoint, idx });
    }

    // Break if collected enough indexes
    if (result.length >= totalIndexes) {
      break;
    }
  }

  // Trim to exact size if needed
  return result.slice(0, totalIndexes);
}

/**
 * Send messages to an SQS queue using batch operations
 */
async function sendMessagesToQueue(messages: EndpointIndexPair[], queueUrl: string): Promise<void> {
  console.log(`Sending ${messages.length} messages to queue: ${queueUrl}`);
  const BATCH_SIZE = 10;
  const batchPromises: Promise<any>[] = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batchMessages = messages.slice(i, i + BATCH_SIZE);

    const entries = batchMessages.map((message, index) => ({
      Id: `msg-${i + index}`,
      MessageBody: JSON.stringify(message)
    }));

    const command = new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: entries
    });

    batchPromises.push(sqsClient.send(command));
  }

  await Promise.allSettled(batchPromises);
}

/**
 * Main Lambda handler
 */
export async function findAvailableSlots(context: Context): Promise<LambdaResponse> {
  console.log('FindAvailableSlots lambda started - checking queue depths');
  setupLogger(context);
  logger.info(LogMessage.FAS_LAMBDA_STARTED);
  try {
    const queueRefills = await calculateQueueRefills();

    // If both queues are full, early termination
    if (queueRefills[QueueType.Bitstring].neededMessages === 0 &&
      queueRefills[QueueType.TokenStatus].neededMessages === 0) {
      console.log('All queues are at or above target depth. No refill needed.');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No queue refill needed',
          bitstringDepth: queueRefills[QueueType.Bitstring].currentDepth,
          tokenStatusDepth: queueRefills[QueueType.TokenStatus].currentDepth
        })
      };
    }

    // Fetch configuration from S3
    const config = await getConfiguration();

    // Determine the minimum maxIndices value across all entries
    const maxIndexesPerEndpoint = [
      ...config.bitstringStatusList.map(item => item.maxIndices),
      ...config.tokenStatusList.map(item => item.maxIndices)
    ];
    const maxIndexPerEndpoint = Math.min(...maxIndexesPerEndpoint);
    console.log(`Allocating ${maxIndexPerEndpoint} indexes per endpoint`);

    // Extract URIs from the config
    const bitstringEndpoints = config.bitstringStatusList.map(item => item.uri);
    const tokenStatusEndpoints = config.tokenStatusList.map(item => item.uri);

    let bitstringAdded = 0;
    let tokenStatusAdded = 0;

    // Refill Bitstring queue if needed
    const bitstringNeeded = queueRefills[QueueType.Bitstring].neededMessages;
    if (bitstringNeeded > 0) {
      console.log(`Refilling Bitstring queue with ${bitstringNeeded} messages`);
      const bitstringIndexes = selectRandomIndexes(bitstringEndpoints, bitstringNeeded, maxIndexPerEndpoint);
      await sendMessagesToQueue(bitstringIndexes, BITSTRING_QUEUE_URL);
      bitstringAdded = bitstringIndexes.length;
    }

    // Refill TokenStatus queue if needed
    const tokenStatusNeeded = queueRefills[QueueType.TokenStatus].neededMessages;
    if (tokenStatusNeeded > 0) {
      console.log(`Refilling TokenStatus queue with ${tokenStatusNeeded} messages`);
      const tokenStatusIndexes = selectRandomIndexes(tokenStatusEndpoints, tokenStatusNeeded, maxIndexPerEndpoint);
      await sendMessagesToQueue(tokenStatusIndexes, TOKEN_STATUS_QUEUE_URL);
      tokenStatusAdded = tokenStatusIndexes.length;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Successfully refilled queues',
        bitstringQueueStatus: {
          previousDepth: queueRefills[QueueType.Bitstring].currentDepth,
          messagesAdded: bitstringAdded,
          newDepth: queueRefills[QueueType.Bitstring].currentDepth + bitstringAdded
        },
        tokenStatusQueueStatus: {
          previousDepth: queueRefills[QueueType.TokenStatus].currentDepth,
          messagesAdded: tokenStatusAdded,
          newDepth: queueRefills[QueueType.TokenStatus].currentDepth + tokenStatusAdded
        }
      })
    };
  } catch (error) {
    console.error('Error in lambda execution:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error refilling queues',
        error: error instanceof Error ? error.message : String(error)
      })
    };
  }
}
