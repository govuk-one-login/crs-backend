// // Set environment variables before import
import { LogMessage } from "../../../src/common/logging/LogMessages";

process.env.BITSTRING_QUEUE_URL = "testBitstringQueueUrl";
process.env.TOKEN_STATUS_QUEUE_URL = "testTokenStatusQueueUrl";
process.env.LIST_CONFIGURATION_BUCKET = "testBucket";
process.env.CONFIGURATION_FILE_KEY = "testKey";
process.env.TARGET_QUEUE_DEPTH = "10000";

import { Readable } from "stream";
import { Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  SQSClient,
  GetQueueAttributesCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import {
  handler,
  getQueueDepth,
  getConfiguration,
  selectRandomIndexes,
} from "../../../src/functions/findAvailableSlotsHandler";
import { logger } from "../../../src/common/logging/logger";
import { sdkStreamMixin } from "@smithy/util-stream-node";
import { describe, expect } from "@jest/globals";

// Mock AWS clients
const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

// Common test data and configurations
const validConfig = {
  bitstringStatusList: [
    { created: "2025-01-01", uri: "bit1", maxIndices: 10000, format: "" },
  ],
  tokenStatusList: [
    { created: "2025-01-01", uri: "token1", maxIndices: 10000, format: "" },
  ],
};

const limitedConfig = {
  bitstringStatusList: [
    { created: "2025-01-01", uri: "bit1", maxIndices: 100, format: "" },
  ],
  tokenStatusList: [
    { created: "2025-01-01", uri: "token1", maxIndices: 100, format: "" },
  ],
};

const emptyConfig = {
  bitstringStatusList: [],
  tokenStatusList: [],
};

const invalidConfig = {
  bitstringStatusList: [
    { created: "2025-01-01", URL: "bit1", maxIndices: 10000, format: "" },
  ],
  tokenStatusList: [
    { created: "2025-01-01", URL: "token1", maxIndices: 10000, format: "" },
  ],
};

const createS3Body = (content: unknown) => {
  return {
    Body: sdkStreamMixin(Readable.from([JSON.stringify(content)])),
  };
};

const mockQueueDepths = (bitstringDepth: string, tokenStatusDepth: string) => {
  return sqsMock
    .on(GetQueueAttributesCommand)
    .resolvesOnce({
      Attributes: { ApproximateNumberOfMessages: bitstringDepth },
    })
    .resolvesOnce({
      Attributes: { ApproximateNumberOfMessages: tokenStatusDepth },
    });
};

describe("Testing FindAvailableSlots Lambda", () => {
  // Store original environment variables
  const originalBitstringUrl = process.env.BITSTRING_QUEUE_URL;
  const originalTokenStatusUrl = process.env.TOKEN_STATUS_QUEUE_URL;

  let context: Context;
  let loggerInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    loggerInfoSpy = jest.spyOn(logger, "info");
    context = { functionVersion: "1" } as unknown as Context;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Restore env variables so other tests aren't affected
    process.env.BITSTRING_QUEUE_URL = originalBitstringUrl;
    process.env.TOKEN_STATUS_QUEUE_URL = originalTokenStatusUrl;
  });

  describe("On every invocation", () => {
    it("logs STARTED message and COMPLETED message", async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: { ApproximateNumberOfMessages: "10000" },
      });
      await handler(context);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.FIND_AVAILABLE_SLOTS_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.FIND_AVAILABLE_SLOTS_LAMBDA_COMPLETED,
      );
    });
  });

  describe("Happy Path Scenarios", () => {
    it("should return 200 and skip refill if both queues are at/above the target depth", async () => {
      // Mock getQueueDepth to return high numbers for both queues
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: { ApproximateNumberOfMessages: "10000" },
      });

      // No need to mock S3 because we won't fetch config if we return early
      const response = await handler(context);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.FIND_AVAILABLE_SLOTS_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenLastCalledWith(
        LogMessage.FIND_AVAILABLE_SLOTS_LAMBDA_COMPLETED,
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).message).toMatch(
        /No queue refill needed/,
      );
    });

    it("should return 200 and refill both queues as needed", async () => {
      // Queues are low, so we need to refill
      mockQueueDepths("5000", "5000");

      // Mock S3 to return valid configuration
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      // Mock sending messages to queue
      sqsMock
        .on(SendMessageBatchCommand)
        .resolves({ Failed: [], Successful: [] });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.FIND_AVAILABLE_SLOTS_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenLastCalledWith(
        LogMessage.FIND_AVAILABLE_SLOTS_LAMBDA_COMPLETED,
      );

      expect(response.statusCode).toBe(200);
      expect(body.message).toBe("Successfully refilled queues");
      expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
      expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
    });

    it("should refill only the TokenStatus queue if Bitstring is already above target", async () => {
      // Mock distinct queue depths
      mockQueueDepths("10000", "5000");

      // Mock S3 config
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      // Mock sending messages
      sqsMock
        .on(SendMessageBatchCommand)
        .resolves({ Failed: [], Successful: [] });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      // bitstring queue wouldn't add messages
      expect(response.statusCode).toBe(200);
      expect(body.bitstringQueueStatus.messagesAdded).toBe(0);
      expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
    });

    it("should refill only the Bitstring queue if TokenStatus is already above target", async () => {
      // Mock distinct queue depths
      mockQueueDepths("5000", "10000");

      // Mock S3 config
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      // Mock sending messages
      sqsMock
        .on(SendMessageBatchCommand)
        .resolves({ Failed: [], Successful: [] });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      // tokenStatus queue wouldn't add messages
      expect(response.statusCode).toBe(200);
      expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
      expect(body.tokenStatusQueueStatus.messagesAdded).toBe(0);
    });

    it("should get queue depths from SQS", async () => {
      // Mock SQS to return queue depths
      mockQueueDepths("5000", "5000");

      // Mock S3 to return valid configuration
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      // Mock sending messages to queue
      sqsMock
        .on(SendMessageBatchCommand)
        .resolves({ Failed: [], Successful: [] });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body.bitstringQueueStatus.previousDepth).toBe(5000);
      expect(body.tokenStatusQueueStatus.previousDepth).toBe(5000);
    });

    it("should handle mixed success/failure when sending messages", async () => {
      // Mock queue depths to trigger refill
      mockQueueDepths("5000", "5000");

      // Mock S3 with valid config
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      // Mock sending messages with mixed success/failure
      sqsMock.on(SendMessageBatchCommand).resolves({
        Failed: [
          { Id: "msg-1", SenderFault: true, Code: "400", Message: "Failed" },
        ],
        Successful: [
          { Id: "msg-0", MessageId: "12345", MD5OfMessageBody: "abcde" },
        ],
      });

      const response = await handler(context);

      // Even with partial failures, the operation should succeed overall
      expect(response.statusCode).toBe(200);
    });
  });

  describe("Error Handling", () => {
    it("should return 500 if there are not enough indexes to refill queues", async () => {
      // Mock queue depth so we need messages
      mockQueueDepths("5000", "5000");

      // Mock S3 config with only limited max indices
      s3Mock.on(GetObjectCommand).resolves(createS3Body(limitedConfig));

      const response = await handler(context);
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toContain("Not enough indexes");
    });

    it("should handle error if fetching queue attributes throws an exception", async () => {
      // Force an error on SQS
      sqsMock.on(GetQueueAttributesCommand).rejects(new Error("SQS error"));

      const response = await handler(context);
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toContain("SQS error");
    });

    it("should handle error if S3 client fails to retrieve configuration", async () => {
      // Mock queue attributes so we proceed to fetch config
      mockQueueDepths("9000", "9000");

      // Force an error in S3
      s3Mock.on(GetObjectCommand).rejectsOnce(new Error("S3 failure"));

      const response = await handler(context);
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toContain("S3 failure");
    });

    it("should handle empty endpoint list in S3 config", async () => {
      // Mock queue depths
      mockQueueDepths("5000", "5000");

      // Mock S3 config with empty endpoint list
      s3Mock.on(GetObjectCommand).resolves(createS3Body(emptyConfig));

      // Mock sending messages
      sqsMock
        .on(SendMessageBatchCommand)
        .resolves({ Failed: [], Successful: [] });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      // This should be a 500 error response because there's no information in the config
      expect(response.statusCode).toBe(500);
      expect(body.error).toBe("No endpoints found in configuration");
    });

    it("should handle invalid JSON in S3 config", async () => {
      // Mock queue depths
      mockQueueDepths("5000", "5000");

      // Mock S3 config with invalid JSON (URL instead of uri)
      s3Mock.on(GetObjectCommand).resolves(createS3Body(invalidConfig));

      // Mock sending messages
      sqsMock
        .on(SendMessageBatchCommand)
        .resolves({ Failed: [], Successful: [] });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      // This should be a 500 error response because there is no uri information in the config
      expect(response.statusCode).toBe(500);
      expect(body.error).toBe("Invalid JSON configuration format");
    });

    it("should handle empty message arrays when sending to queue", async () => {
      // Mock queue depths to trigger refill for bitstring only
      mockQueueDepths("5000", "10000");

      // Create a configuration with empty bitstring list
      const emptyBitstringConfig = {
        bitstringStatusList: [], // Empty list for bitstring
        tokenStatusList: [
          {
            created: "2025-01-01",
            uri: "token1",
            maxIndices: 1000,
            format: "",
          },
        ],
      };

      s3Mock.on(GetObjectCommand).resolves(createS3Body(emptyBitstringConfig));

      // Call the function
      const response = await handler(context);

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(500);
      expect(body.error).toContain("Not enough indexes to refill queues");

      // Verify SQS sendMessageBatch was never called
      const sqsSendCalls = sqsMock.commandCalls(SendMessageBatchCommand);
      expect(sqsSendCalls.length).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty response from SQS getQueueAttributes", async () => {
      // Mock SQS to return empty response (no Attributes field)
      sqsMock.on(GetQueueAttributesCommand).resolves({});

      const response = await handler(context);
      expect(response.statusCode).toBe(500);
    });

    it("should handle non-numeric ApproximateNumberOfMessages", async () => {
      // Mock SQS to return non-numeric value
      mockQueueDepths("NaN", "5000");

      // Mock S3 with valid config
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      const response = await handler(context);
      // Should still work, parseInt will handle this and return 0 (NaN) for the first one
      expect(response.statusCode).toBe(200);
    });

    it("should handle empty message array and skip sending", async () => {
      // Mock queue depths to trigger refill but with no actual messages to send
      mockQueueDepths("9999", "9999");

      // Mock S3 with valid config but all URIs will get exhausted quickly
      const minimalConfig = {
        bitstringStatusList: [
          { created: "2025-01-01", uri: "bit1", maxIndices: 1, format: "" },
        ],
        tokenStatusList: [
          { created: "2025-01-01", uri: "token1", maxIndices: 1, format: "" },
        ],
      };

      s3Mock.on(GetObjectCommand).resolves(createS3Body(minimalConfig));

      // Spy on SendMessageBatchCommand to ensure it isn't called
      const sendMessageSpy = jest.spyOn(sqsMock, "send");

      await handler(context);

      // Verify that SendMessageBatchCommand was called only for queue depth checks
      // but not for actual message sending (which would be more than 2 calls)
      expect(sendMessageSpy.mock.calls.length).toBeLessThan(3);
    });

    it("should handle failures when sending messages to SQS", async () => {
      // Mock queue depths
      mockQueueDepths("5000", "5000");

      // Mock S3 config
      s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

      // Mock sending messages to SQS with a failure
      sqsMock.on(SendMessageBatchCommand).resolves({
        Failed: [
          {
            Id: "1",
            SenderFault: true,
            Message: "Failed to send message",
            Code: "Sender",
          },
        ],
        Successful: [],
      });

      const response = await handler(context);
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body.message).toBe("Successfully refilled queues");
      expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
      expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
    });
  });
});

describe("getQueueDepth", () => {
  beforeEach(() => {
    sqsMock.reset();
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should throw an error when called with an empty queue URL", async () => {
    await expect(getQueueDepth("")).rejects.toThrow("Queue URL is missing");
  });

  it("should throw an error when called with undefined queue URL", async () => {
    await expect(getQueueDepth(undefined as unknown as string)).rejects.toThrow(
      "Queue URL is missing",
    );
  });

  it("should throw an error when called with null queue URL", async () => {
    await expect(getQueueDepth(null as unknown as string)).rejects.toThrow(
      "Queue URL is missing",
    );
  });

  it("should return the message count when called with a valid queue URL", async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: "42" },
    });

    const result = await getQueueDepth("https://valid-queue-url");
    expect(result).toBe(42);
  });

  it("should handle SQS client errors", async () => {
    sqsMock
      .on(GetQueueAttributesCommand)
      .rejects(new Error("SQS service error"));

    await expect(getQueueDepth("https://valid-queue-url")).rejects.toThrow(
      "Error getting queue attributes",
    );
  });
});

describe("getConfiguration", () => {
  beforeEach(() => {
    s3Mock.reset();
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should return configuration from S3 when default valid parameters are provided", async () => {
    s3Mock.on(GetObjectCommand).resolves(createS3Body(validConfig));

    const result = await getConfiguration();

    expect(result).toEqual(validConfig);
    expect(result.bitstringStatusList[0].uri).toBe("bit1");
  });
});

describe("selectRandomIndexes", () => {
  it("should return empty array for empty endpoints", () => {
    const result = selectRandomIndexes([], 10, 100);
    expect(result).toEqual([]);
  });

  it("should return empty array for zero totalIndexes", () => {
    const result = selectRandomIndexes(["endpoint1"], 0, 100);
    expect(result).toEqual([]);
  });
});
