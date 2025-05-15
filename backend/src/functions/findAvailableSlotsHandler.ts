import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  SQSClient,
  SendMessageBatchCommand,
  GetQueueAttributesCommand,
  SendMessageBatchCommandOutput,
} from "@aws-sdk/client-sqs";
import { Readable } from "stream";
import { Context } from "aws-lambda";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";

// AWS Clients
const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

// Constants
const BATCH_SIZE = 10; // Number of messages in an SQS batch
const DEFAULT_CONFIG_KEY = "ListConfiguration.json";
const DEFAULT_TARGET_QUEUE_DEPTH = 10000;

// Environment variables with defaults
const ENV = {
  BITSTRING_QUEUE_URL: process.env.BITSTRING_QUEUE_URL || "",
  TOKEN_STATUS_QUEUE_URL: process.env.TOKEN_STATUS_QUEUE_URL || "",
  CONFIG_BUCKET: process.env.LIST_CONFIGURATION_BUCKET || "",
  CONFIG_KEY: process.env.CONFIGURATION_FILE_KEY || DEFAULT_CONFIG_KEY,
  TARGET_QUEUE_DEPTH: parseInt(
    process.env.TARGET_QUEUE_DEPTH || String(DEFAULT_TARGET_QUEUE_DEPTH),
    10,
  ),
};

enum QueueType {
  Bitstring = "Bitstring",
  TokenStatus = "TokenStatus",
}

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

interface QueueStatus {
  currentDepth: number;
  neededMessages: number;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

interface QueueRefillResult {
  previousDepth: number;
  messagesAdded: number;
  newDepth: number;
}

interface RefillResult {
  bitstringQueueStatus: QueueRefillResult;
  tokenStatusQueueStatus: QueueRefillResult;
  message: string;
}

/**
 * Set up the logger with the current context
 */
function setupLogger(context: Context): void {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

/**
 * Get the current number of messages in a queue
 * @param queueUrl SQS Queue URL
 * @returns The number of messages in the queue
 * @internal Exported for testing purposes only
 */
export async function getQueueDepth(queueUrl: string): Promise<number> {
  if (!queueUrl) {
    logger.error("Queue URL is missing");
    throw new Error("Queue URL is missing");
  }

  logger.info(`Getting attributes for queue: ${queueUrl}`);

  try {
    const command = new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages"],
    });

    const response = await sqsClient.send(command);
    const messageCount = parseInt(
      response.Attributes?.ApproximateNumberOfMessages || "0",
      10,
    );

    if (isNaN(messageCount)) {
      logger.warn(
        `Queue ${queueUrl} returned non-numeric message count ${response.Attributes?.ApproximateNumberOfMessages}. Assuming 0.`,
      );
      return 0;
    }

    logger.info(`Queue ${queueUrl} has approximately ${messageCount} messages`);
    return messageCount;
  } catch (error) {
    logger.error(`Error getting queue attributes for ${queueUrl}:`, error);
    throw new Error(`Error getting queue attributes: ${error}`);
  }
}

/**
 * Fetch the configuration from S3
 * @param bucket S3 bucket name (optional, defaults to environment variable)
 * @param key S3 object key (optional, defaults to environment variable)
 * @returns The parsed configuration object
 * @internal Exported for testing purposes only
 */
export async function getConfiguration(
  bucket?: string,
  key?: string,
): Promise<ListConfiguration> {
  const configBucket = bucket !== undefined ? bucket : ENV.CONFIG_BUCKET;
  const configKey = key !== undefined ? key : ENV.CONFIG_KEY;

  if (!configBucket || !configKey) {
    logger.error("S3 bucket or key not defined");
    throw new Error("S3 bucket or key not defined");
  }

  logger.info(
    `Fetching configuration from S3: bucket=${configBucket}, key=${configKey}`,
  );

  try {
    const command = new GetObjectCommand({
      Bucket: configBucket,
      Key: configKey,
    });

    const response = await s3Client.send(command);
    const bodyText = await streamToString(response.Body as Readable);
    logger.info(`Fetched configuration successfully`);
    return JSON.parse(bodyText) as ListConfiguration;
  } catch (error) {
    logger.error("Error fetching configuration from S3:", error);
    throw error;
  }
}

/**
 * Convert a readable stream to string
 */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Calculate how many messages to add to each queue
 * @returns Status of each queue including current depth and needed messages
 */
async function calculateQueueRefills(): Promise<
  Record<QueueType, QueueStatus>
> {
  // Get current queue depths
  const bitstringDepth = await getQueueDepth(ENV.BITSTRING_QUEUE_URL);
  const tokenStatusDepth = await getQueueDepth(ENV.TOKEN_STATUS_QUEUE_URL);

  const bitstringNeeded =
    Math.max(0, ENV.TARGET_QUEUE_DEPTH - bitstringDepth) / 10; //TODO: Remove division by 10
  const tokenStatusNeeded =
    Math.max(0, ENV.TARGET_QUEUE_DEPTH - tokenStatusDepth) / 10; //TODO: Remove division by 10

  logger.info(
    `Bitstring queue: ${bitstringDepth} messages, need to add ${bitstringNeeded}`,
  );
  logger.info(
    `Token Status queue: ${tokenStatusDepth} messages, need to add ${tokenStatusNeeded}`,
  );

  return {
    [QueueType.Bitstring]: {
      currentDepth: bitstringDepth,
      neededMessages: bitstringNeeded,
    },
    [QueueType.TokenStatus]: {
      currentDepth: tokenStatusDepth,
      neededMessages: tokenStatusNeeded,
    },
  };
}

/**
 * Validates the configuration format
 * @param config The configuration to validate
 * @returns True if valid, false otherwise
 */
function validateConfigFormat(config: ListConfiguration): boolean {
  const isValidBitstringConfig = config.bitstringStatusList.every(
    (item) =>
      typeof item.uri === "string" &&
      typeof item.maxIndices === "number" &&
      typeof item.format === "string" &&
      typeof item.created === "string",
  );

  const isValidTokenStatusConfig = config.tokenStatusList.every(
    (item) =>
      typeof item.uri === "string" &&
      typeof item.maxIndices === "number" &&
      typeof item.format === "string" &&
      typeof item.created === "string",
  );

  return isValidBitstringConfig && isValidTokenStatusConfig;
}

/**
 * Checks if there are enough endpoints in the configuration
 * @param config The configuration to check
 * @returns Object with validation result and max index per endpoint
 */
function validateConfigEndpoints(config: ListConfiguration): {
  valid: boolean;
  maxIndexPerEndpoint: number;
} {
  // Determine the minimum maxIndices value across all entries, in the event of less than 100k indexes per URL
  const maxIndexesPerEndpoint = [
    ...config.bitstringStatusList.map((item) => item.maxIndices),
    ...config.tokenStatusList.map((item) => item.maxIndices),
  ];

  const maxIndexPerEndpoint =
    maxIndexesPerEndpoint.length > 0
      ? Math.max(0, Math.min(...maxIndexesPerEndpoint))
      : 0;

  const hasEndpoints =
    config.bitstringStatusList.length > 0 || config.tokenStatusList.length > 0;

  return {
    valid: hasEndpoints && maxIndexPerEndpoint > 0,
    maxIndexPerEndpoint,
  };
}

/**
 * Checks if there are enough indexes available to fulfill queue requirements
 * @param bitstringEndpoints Bitstring endpoints
 * @param tokenStatusEndpoints Token status endpoints
 * @param bitstringNeeded Number of bitstring messages needed
 * @param tokenStatusNeeded Number of token status messages needed
 * @param maxIndexPerEndpoint Maximum index per endpoint
 * @returns Object with validation result and available indexes
 */
function validateIndexesAvailability(
  bitstringEndpoints: string[],
  tokenStatusEndpoints: string[],
  bitstringNeeded: number,
  tokenStatusNeeded: number,
  maxIndexPerEndpoint: number,
): {
  valid: boolean;
  totalBitstringIndexes: number;
  totalTokenStatusIndexes: number;
} {
  const totalBitstringIndexes = bitstringEndpoints.length * maxIndexPerEndpoint;
  const totalTokenStatusIndexes =
    tokenStatusEndpoints.length * maxIndexPerEndpoint;

  const hasEnoughIndexes =
    bitstringNeeded <= totalBitstringIndexes &&
    tokenStatusNeeded <= totalTokenStatusIndexes;

  return {
    valid: hasEnoughIndexes,
    totalBitstringIndexes,
    totalTokenStatusIndexes,
  };
}

/**
 * Select random indexes for each endpoint
 * @param endpoints List of endpoint URIs
 * @param totalIndexes Total number of indexes needed
 * @param maxIndexPerEndpoint Maximum index value
 * @returns Array of endpoint-index pairs
 * @internal Exported for testing purposes only
 */
export function selectRandomIndexes(
  endpoints: string[],
  totalIndexes: number,
  maxIndexPerEndpoint: number,
): EndpointIndexPair[] {
  if (endpoints.length === 0 || totalIndexes <= 0) return [];

  const result: EndpointIndexPair[] = [];
  const indexesPerEndpoint = Math.ceil(
    totalIndexes / Math.min(totalIndexes, endpoints.length),
  );
  logger.info(`Selecting ${indexesPerEndpoint} indexes per endpoint`);

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
 * @param messages Messages to send
 * @param queueUrl Queue URL
 */
async function sendMessagesToQueue(
  messages: EndpointIndexPair[],
  queueUrl: string,
): Promise<void> {
  if (messages.length === 0) {
    logger.info(`No messages to send to queue: ${queueUrl}`);
    return;
  }

  logger.info(`Sending ${messages.length} messages to queue: ${queueUrl}`);
  const batchPromises: Promise<SendMessageBatchCommandOutput>[] = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batchMessages = messages.slice(i, i + BATCH_SIZE);

    const entries = batchMessages.map((message, index) => ({
      Id: `msg-${i + index}`,
      MessageBody: JSON.stringify(message),
    }));

    const command = new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: entries,
    });

    batchPromises.push(sqsClient.send(command));
  }

  await Promise.allSettled(batchPromises);
}

/**
 * Handle the case where all queues are already full
 * @param queueRefills Current queue status
 * @returns Response object
 */
function handleQueuesAlreadyFull(
  queueRefills: Record<QueueType, QueueStatus>,
): LambdaResponse {
  logger.info("All queues are at or above target depth. No refill needed.");
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "No queue refill needed",
      bitstringDepth: queueRefills[QueueType.Bitstring].currentDepth,
      tokenStatusDepth: queueRefills[QueueType.TokenStatus].currentDepth,
    }),
  };
}

/**
 * Process queue refills and return the result
 * @param queueRefills Current queue status
 * @param config Configuration object
 * @returns Object containing refill results
 */
async function processQueueRefills(
  queueRefills: Record<QueueType, QueueStatus>,
  config: ListConfiguration,
): Promise<RefillResult> {
  // Validate the configuration format
  if (!validateConfigFormat(config)) {
    throw new Error("Invalid JSON configuration format");
  }

  // Validate and get max index per endpoint
  const { valid: hasValidEndpoints, maxIndexPerEndpoint } =
    validateConfigEndpoints(config);
  if (!hasValidEndpoints) {
    throw new Error("No endpoints found in configuration");
  }

  logger.info(
    `List configuration validated successfully, processing ${config.bitstringStatusList.length + config.tokenStatusList.length} endpoints, with ${maxIndexPerEndpoint} indexes per endpoint`,
  );

  // Extract URIs from the config
  const bitstringEndpoints = config.bitstringStatusList.map((item) => item.uri);
  const tokenStatusEndpoints = config.tokenStatusList.map((item) => item.uri);

  // Get needed messages counts
  const bitstringNeeded = queueRefills[QueueType.Bitstring].neededMessages;
  const tokenStatusNeeded = queueRefills[QueueType.TokenStatus].neededMessages;

  // Check if we have enough indexes to fulfill the requests
  const {
    valid: hasEnoughIndexes,
    totalBitstringIndexes,
    totalTokenStatusIndexes,
  } = validateIndexesAvailability(
    bitstringEndpoints,
    tokenStatusEndpoints,
    bitstringNeeded,
    tokenStatusNeeded,
    maxIndexPerEndpoint,
  );

  if (!hasEnoughIndexes) {
    throw new Error(
      `Not enough indexes to refill queues. 
      Bitstring needed: ${bitstringNeeded}, available: ${totalBitstringIndexes}. 
      TokenStatus needed: ${tokenStatusNeeded}, available: ${totalTokenStatusIndexes}.`,
    );
  }
  let bitstringAdded = 0;
  let tokenStatusAdded = 0;

  // Refill Bitstring queue if needed
  if (bitstringNeeded > 0) {
    logger.info(`Refilling Bitstring queue with ${bitstringNeeded} messages`);
    const bitstringIndexes = selectRandomIndexes(
      bitstringEndpoints,
      bitstringNeeded,
      maxIndexPerEndpoint,
    );
    await sendMessagesToQueue(bitstringIndexes, ENV.BITSTRING_QUEUE_URL);
    bitstringAdded = bitstringIndexes.length;
  }

  // Refill TokenStatus queue if needed
  if (tokenStatusNeeded > 0) {
    logger.info(
      `Refilling TokenStatus queue with ${tokenStatusNeeded} messages`,
    );
    const tokenStatusIndexes = selectRandomIndexes(
      tokenStatusEndpoints,
      tokenStatusNeeded,
      maxIndexPerEndpoint,
    );
    await sendMessagesToQueue(tokenStatusIndexes, ENV.TOKEN_STATUS_QUEUE_URL);
    tokenStatusAdded = tokenStatusIndexes.length;
  }

  logger.info(
    `Refilled queues: ${bitstringAdded} messages added to Bitstring, ${tokenStatusAdded} messages added to TokenStatus`,
  );

  return {
    message: "Successfully refilled queues",
    bitstringQueueStatus: {
      previousDepth: queueRefills[QueueType.Bitstring].currentDepth,
      messagesAdded: bitstringAdded,
      newDepth: queueRefills[QueueType.Bitstring].currentDepth + bitstringAdded,
    },
    tokenStatusQueueStatus: {
      previousDepth: queueRefills[QueueType.TokenStatus].currentDepth,
      messagesAdded: tokenStatusAdded,
      newDepth:
        queueRefills[QueueType.TokenStatus].currentDepth + tokenStatusAdded,
    },
  };
}

/**
 * Main Lambda handler
 * @param context Lambda execution context
 * @returns Lambda response
 */
export async function findAvailableSlots(
  context: Context,
): Promise<LambdaResponse> {
  setupLogger(context);
  logger.info(LogMessage.FAS_LAMBDA_STARTED);
  logger.info("FindAvailableSlots lambda started - checking queue depths");

  try {
    // Calculate how many messages we need to add to each queue
    const queueRefills = await calculateQueueRefills();

    // If both queues are full, early termination
    if (
      queueRefills[QueueType.Bitstring].neededMessages === 0 &&
      queueRefills[QueueType.TokenStatus].neededMessages === 0
    )
      return handleQueuesAlreadyFull(queueRefills);

    // Fetch configuration from S3
    const config = await getConfiguration();

    // Process queue refills
    const result = await processQueueRefills(queueRefills, config);

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    logger.error("Error in lambda execution:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error refilling queues",
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
