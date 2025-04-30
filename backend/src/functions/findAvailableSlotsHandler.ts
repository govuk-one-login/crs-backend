import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Readable } from 'stream';

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

interface LambdaEvent {
  queueType?: QueueType;
  refillSize?: number;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

// SQS queue URLs
const BITSTRING_QUEUE_URL = process.env.BITSTRING_QUEUE_URL || '';
const TOKEN_STATUS_QUEUE_URL = process.env.TOKEN_STATUS_QUEUE_URL || '';

// S3 bucket and configuration file path
const CONFIG_BUCKET = process.env.LIST_CONFIGURATION_BUCKET || '';
const CONFIG_KEY = process.env.CONFIGURATION_FILE_KEY || 'ListConfiguration.json';

// Default allocation values
const INITIAL_ALLOCATION_SIZE = parseInt(process.env.INITIAL_ALLOCATION_SIZE || '10000', 10);
const DEFAULT_REFILL_SIZE = parseInt(process.env.DEFAULT_REFILL_SIZE || '5000', 10);

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
    // Generate random indexes for this endpoint
    const selectedIndexes = new Set<number>();
    while (selectedIndexes.size < indexesPerEndpoint) {
      const randomIndex = Math.floor(Math.random() * maxIndexPerEndpoint);
      selectedIndexes.add(randomIndex);
    }

    // Store the selected indexes with their URI
    for (const idx of selectedIndexes) {
      result.push({ uri: endpoint, idx });
    }

    // Break if we've collected enough indexes
    if (result.length >= totalIndexes) {
      break;
    }
  }

  // Trim to exact size if needed
  return result.slice(0, totalIndexes);
}

/**
 * Send messages to an SQS queue
 */
async function sendMessagesToQueue(messages: EndpointIndexPair[], queueUrl: string): Promise<void> {
  console.log(`Sending messages to queue: ${queueUrl}`);
  const queueMessages: Promise<any>[] = [];

  for (const message of messages) {
    const command = new SendMessageCommand({
      MessageBody: JSON.stringify(message),
      QueueUrl: queueUrl
    });

    queueMessages.push(sqsClient.send(command));
    console.log(`Sending message: ${JSON.stringify(message)}`);
  }

  await Promise.all(queueMessages);
}

/**
 * Main Lambda handler
 */
export const findAvailableSlots = async (event: LambdaEvent = {}, context = {}): Promise<LambdaResponse> => {
  console.log('FindAvailableSlots lambda started with event:', JSON.stringify(event));
  try {
    // Determine if this is an initial run or a refill request
    const isInitialRun = !event.queueType;
    const refillSize = event.refillSize || DEFAULT_REFILL_SIZE;

    // Fetch configuration from S3
    const config = await getConfiguration();

    // Determine the minimum maxIndices value across all entries
    const allMaxIndices = [
      ...config.bitstringStatusList.map(item => item.maxIndices),
      ...config.tokenStatusList.map(item => item.maxIndices)
    ];
    const maxIndexPerEndpoint = Math.min(...allMaxIndices);
    console.log(`Using minimum maxIndices value: ${maxIndexPerEndpoint}`);

    if (isInitialRun) {
      // Initial run - allocate indexes for both queues
      console.log('Initial run: Allocating indexes for both queues');

      // Extract URIs from the config
      const bitstringEndpoints = config.bitstringStatusList.map(item => item.uri);
      const tokenStatusEndpoints = config.tokenStatusList.map(item => item.uri);

      // Select random indexes for both endpoint types
      const bitstringIndexes = selectRandomIndexes(bitstringEndpoints, INITIAL_ALLOCATION_SIZE, maxIndexPerEndpoint);
      const tokenStatusIndexes = selectRandomIndexes(tokenStatusEndpoints, INITIAL_ALLOCATION_SIZE, maxIndexPerEndpoint);

      // Send messages to both queues
      await Promise.all([
        sendMessagesToQueue(bitstringIndexes, BITSTRING_QUEUE_URL),
        sendMessagesToQueue(tokenStatusIndexes, TOKEN_STATUS_QUEUE_URL)
      ]);

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Successfully allocated indexes to both queues',
          bitstringCount: bitstringIndexes.length,
          tokenStatusCount: tokenStatusIndexes.length
        })
      };
    } else {
      // Refill operation for a specific queue
      const queueType = event.queueType;
      console.log(`Refill operation for queue: ${queueType}`);

      if (queueType === QueueType.Bitstring) {
        const bitstringEndpoints = config.bitstringStatusList.map(item => item.uri);

        const bitstringIndexes = selectRandomIndexes(bitstringEndpoints, refillSize, maxIndexPerEndpoint);
        await sendMessagesToQueue(bitstringIndexes, BITSTRING_QUEUE_URL);

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: `Successfully refilled Bitstring queue with ${bitstringIndexes.length} indexes`
          })
        };
      } else if (queueType === QueueType.TokenStatus) {
        const tokenStatusEndpoints = config.tokenStatusList.map(item => item.uri);

        const tokenStatusIndexes = selectRandomIndexes(tokenStatusEndpoints, refillSize, maxIndexPerEndpoint);
        await sendMessagesToQueue(tokenStatusIndexes, TOKEN_STATUS_QUEUE_URL);

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: `Successfully refilled TokenStatus queue with ${tokenStatusIndexes.length} indexes`
          })
        };
      } else {
        throw new Error(`Invalid queue type: ${queueType}`);
      }
    }
  } catch (error) {
    console.error('Error in lambda execution:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error allocating indexes',
        error: error instanceof Error ? error.message : String(error)
      })
    };
  }
};
