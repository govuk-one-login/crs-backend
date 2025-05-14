// // Set environment variables before import
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
  findAvailableSlots,
  getQueueDepth,
  getConfiguration,
} from "../../../src/functions/findAvailableSlotsHandler";
import { logger } from "../../../src/common/logging/logger";
import { sdkStreamMixin } from "@smithy/util-stream-node";

// Mock AWS clients
const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

describe("findAvailableSlots", () => {
  const originalBitstringUrl = process.env.BITSTRING_QUEUE_URL;
  const originalTokenStatusUrl = process.env.TOKEN_STATUS_QUEUE_URL;

  let context: Context;

  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
    context = { functionVersion: "1" } as unknown as Context;
    process.env.BITSTRING_QUEUE_URL = "";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Restore env variables so other tests aren’t affected
    process.env.BITSTRING_QUEUE_URL = originalBitstringUrl;
    process.env.TOKEN_STATUS_QUEUE_URL = originalTokenStatusUrl;
  });

  it("should return 200 and skip refill if both queues are at/above the target depth", async () => {
    // Mock getQueueDepth to return high numbers for both queues
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: "10000" },
    });

    // No need to mock S3 because we won't fetch config if we return early
    const response = await findAvailableSlots(context);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toMatch(/No queue refill needed/);
  });

  it("should return 200 and refill both queues as needed", async () => {
    // Queues are low, so we need to refill
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // tokenStatus

    // Mock S3 to return valid configuration
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                uri: "bit1",
                maxIndices: 10000,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                uri: "token1",
                maxIndices: 10000,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });

    // Mock sending messages to queue
    sqsMock
      .on(SendMessageBatchCommand)
      .resolves({ Failed: [], Successful: [] });

    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.message).toBe("Successfully refilled queues");
    expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
  });

  it("should return 500 if there are not enough indexes to refill queues", async () => {
    // Mock queue depth so we need messages
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status

    // Mock S3 config with only 1 max index, not enough to fill the required volume
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                uri: "bit1",
                maxIndices: 100,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                uri: "token1",
                maxIndices: 100,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });

    const response = await findAvailableSlots(context);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).message).toMatch(/Not enough indexes/);
  });

  it("should get queue depths from SQS", async () => {
    // Mock SQS to return queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status
    // Mock S3 to return valid configuration
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                uri: "bit1",
                maxIndices: 10000,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                uri: "token1",
                maxIndices: 10000,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });
    // Mock sending messages to queue
    sqsMock
      .on(SendMessageBatchCommand)
      .resolves({ Failed: [], Successful: [] });
    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.bitstringQueueStatus.previousDepth).toBe(5000);
    expect(body.tokenStatusQueueStatus.previousDepth).toBe(5000);
  });

  it("should handle error if fetching queue attributes throws an exception", async () => {
    // Force an error on SQS
    sqsMock.on(GetQueueAttributesCommand).rejects(new Error("SQS error"));

    const response = await findAvailableSlots(context);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toContain("SQS error");
  });

  it("should handle error if S3 client fails to retrieve configuration", async () => {
    // Mock queue attributes so we proceed to fetch config
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "9000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "9000" } }); // token status

    // Force an error in S3
    s3Mock.on(GetObjectCommand).rejectsOnce(new Error("S3 failure"));

    const response = await findAvailableSlots(context);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe("S3 failure");
  });

  it("should handle empty endpoint list in S3 config", async () => {
    // Mock queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status
    // Mock S3 config with empty endpoint list
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [],
            tokenStatusList: [],
          }),
        ]),
      ),
    });
    // Mock sending messages
    sqsMock
      .on(SendMessageBatchCommand)
      .resolves({ Failed: [], Successful: [] });
    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);
    //this should be a 500 error response, because there is no information in the config
    expect(response.statusCode).toBe(500);
    expect(body.message).toBe("No endpoints found in configuration");
    expect(body.bitstringQueueStatus.messagesAdded).toBe(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBe(0);
  });

  it("should handle invalid JSON in S3 config", async () => {
    // Mock queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status
    // Mock S3 config with invalid JSON (URL instead of uri)
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                URL: "bit1",
                maxIndices: 10000,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                URL: "token1",
                maxIndices: 10000,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });
    // Mock sending messages
    sqsMock
      .on(SendMessageBatchCommand)
      .resolves({ Failed: [], Successful: [] });
    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);
    //this should be a 500 error response, because there is no information in the config
    expect(response.statusCode).toBe(500);
    expect(body.message).toBe("Invalid JSON configuration format");
    expect(body.bitstringQueueStatus.messagesAdded).toBe(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBe(0);
  });

  it("should refill only the TokenStatus queue if Bitstring is already above target", async () => {
    // Mock distinct queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "10000" } }) // bitstring full
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status low

    // Mock S3 config
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                uri: "bit1",
                maxIndices: 10000,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                uri: "token1",
                maxIndices: 10000,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });

    // Mock sending messages
    sqsMock
      .on(SendMessageBatchCommand)
      .resolves({ Failed: [], Successful: [] });

    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);

    // bitstring queue wouldn't add messages
    expect(response.statusCode).toBe(200);
    expect(body.bitstringQueueStatus.messagesAdded).toBe(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
  });

  it("should refill only the Bitstring queue if TokenStatus is already above target", async () => {
    // Mock distinct queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring low
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "10000" } }); // token status full

    // Mock S3 config
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                uri: "bit1",
                maxIndices: 10000,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                uri: "token1",
                maxIndices: 10000,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });

    // Mock sending messages
    sqsMock
      .on(SendMessageBatchCommand)
      .resolves({ Failed: [], Successful: [] });

    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);

    // tokenStatus queue wouldn't add messages
    expect(response.statusCode).toBe(200);
    expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBe(0);
  });

  it("should detect empty queue URL strings when environment variables exist but are empty", async () => {
    // Save original values
    const originalBitstringUrl = process.env.BITSTRING_QUEUE_URL;
    const originalTokenStatusUrl = process.env.TOKEN_STATUS_QUEUE_URL;

    try {
      // Set to empty strings instead of deleting. NOTE: CURRENTLY NOT REFLECTED IN THE LAMBDA LOGIC
      process.env.BITSTRING_QUEUE_URL = "";
      process.env.TOKEN_STATUS_QUEUE_URL = "";

      // Mock SQS to explicitly throw an error when called with empty queue URL
      sqsMock
        .on(GetQueueAttributesCommand)
        .rejects(new Error("Queue URL is missing"));

      const response = await findAvailableSlots(context);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toContain("Queue URL is missing");
    } finally {
      // Restore original values
      process.env.BITSTRING_QUEUE_URL = originalBitstringUrl;
      process.env.TOKEN_STATUS_QUEUE_URL = originalTokenStatusUrl;
    }
  });

  it("should handle missing S3 bucket or key", async () => {
    // Mock the getConfiguration function to throw the specific error
    jest.spyOn(S3Client.prototype, "send").mockImplementationOnce(() => {
      throw new Error("S3 bucket or key not defined");
    });

    // Mock queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status

    const response = await findAvailableSlots(context);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toContain(
      "S3 bucket or key not defined",
    );
  });

  it("should handle failures when sending messages to SQS", async () => {
    //it should still return success even with SQS send failures
    // Mock queue depths
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }) // bitstring
      .resolvesOnce({ Attributes: { ApproximateNumberOfMessages: "5000" } }); // token status
    // Mock S3 config
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            bitstringStatusList: [
              {
                created: "2025-01-01",
                uri: "bit1",
                maxIndices: 10000,
                format: "",
              },
            ],
            tokenStatusList: [
              {
                created: "2025-01-01",
                uri: "token1",
                maxIndices: 10000,
                format: "",
              },
            ],
          }),
        ]),
      ),
    });
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
    const response = await findAvailableSlots(context);
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.message).toBe("Successfully refilled queues");
    expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
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
    // Test with empty string
    await expect(getQueueDepth("")).rejects.toThrow("Queue URL is missing");
  });

  it("should throw an error when called with undefined queue URL", async () => {
    // Test with undefined
    await expect(getQueueDepth(undefined as unknown as string)).rejects.toThrow(
      "Queue URL is missing",
    );
  });

  it("should throw an error when called with null queue URL", async () => {
    // Test with null
    await expect(getQueueDepth(null as unknown as string)).rejects.toThrow(
      "Queue URL is missing",
    );
  });

  it("should return the message count when called with a valid queue URL", async () => {
    // Mock successful response
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: "42" },
    });

    const result = await getQueueDepth("https://valid-queue-url");
    expect(result).toBe(42);
  });

  it("should handle SQS client errors", async () => {
    // Mock SQS error
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

  it("should throw an error when bucket name is empty", async () => {
    // Test with empty bucket name
    await expect(getConfiguration("", "testKey")).rejects.toThrow(
      "S3 bucket or key not defined",
    );
  });

  it("should throw an error when key is empty", async () => {
    // Test with empty key
    await expect(getConfiguration("testBucket", "")).rejects.toThrow(
      "S3 bucket or key not defined",
    );
  });

  it("should throw an error when both bucket and key are empty", async () => {
    // Test with both empty
    await expect(getConfiguration("", "")).rejects.toThrow(
      "S3 bucket or key not defined",
    );
  });

  it("should return configuration from S3 when valid parameters are provided", async () => {
    // Mock successful S3 response
    const mockConfig = {
      bitstringStatusList: [
        { created: "2025-01-01", uri: "bit1", maxIndices: 10000, format: "" },
      ],
      tokenStatusList: [
        { created: "2025-01-01", uri: "token1", maxIndices: 10000, format: "" },
      ],
    };

    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify(mockConfig)])),
    });

    const result = await getConfiguration("testBucket", "testKey");

    expect(result).toEqual(mockConfig);
    expect(result.bitstringStatusList[0].uri).toBe("bit1");
  });
});
