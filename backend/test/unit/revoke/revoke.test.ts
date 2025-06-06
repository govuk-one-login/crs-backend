process.env.STATUS_LIST_TABLE = "StatusListTable";
import { handler } from "../../../src/functions/revokeHandler";
import { logger } from "../../../src/common/logging/logger";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import { Context, APIGatewayProxyEvent } from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { buildLambdaContext } from "../../utils/mockContext";
import { buildRequest } from "../../utils/mockRequest";

jest.mock("../../../src/common/logging/logger", () => ({
  logger: {
    resetKeys: jest.fn(),
    addContext: jest.fn(),
    appendKeys: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockDBClient = mockClient(DynamoDBClient);

describe("revoke handler", () => {
  let context: Context;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDBClient.reset();
    context = buildLambdaContext();
  });

  const createTestEvent = (payload: object): APIGatewayProxyEvent => ({
    ...buildRequest(),
    body: JSON.stringify(payload),
  });

  describe("successful revocation scenarios", () => {
    it("should return 202 Accepted for new revocation with TokenStatusList", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      // Parse response body to extract timestamp
      const responseBody = JSON.parse(response.body);

      expect(response).toStrictEqual({
        statusCode: 202,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Request accepted for revocation",
          revokedAt: responseBody.revokedAt,
        }),
      });

      // Additional validation for timestamp format
      expect(responseBody.revokedAt).toMatch(/^\d+$/);
      expect(parseInt(responseBody.revokedAt)).toBeGreaterThan(0);

      expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
      expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it("should return 202 Accepted for new revocation with BitstringStatusList", async () => {
      const payload = {
        iss: "client1",
        idx: 456,
        uri: "https://dummy-uri/b/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "456" },
          listType: { S: "BitstringStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      const event = createTestEvent(payload);
      const response = await handler(event, context);
      const responseBody = JSON.parse(response.body);

      expect(response).toStrictEqual({
        statusCode: 202,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Request accepted for revocation",
          revokedAt: responseBody.revokedAt,
        }),
      });

      // Additional validation for timestamp format
      expect(responseBody.revokedAt).toMatch(/^\d+$/);
      expect(parseInt(responseBody.revokedAt)).toBeGreaterThan(0);
    });

    it("should return 200 OK for already revoked credential", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
          revokedAt: { N: "1640995200" },
        },
      });

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Credential already revoked",
          revokedAt: "1640995200",
        }),
      });

      expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
      expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });
  });

  describe("error scenarios", () => {
    it("should return 400 if request body is missing", async () => {
      const event = { ...buildRequest(), body: null };
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "No Request Body Found",
        }),
      });
    });

    it("should return 400 if payload cannot be parsed", async () => {
      const event = { ...buildRequest(), body: "invalid-json" };
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Error decoding payload",
        }),
      });
    });

    it("should return 400 for missing required fields", async () => {
      const payload = { iss: "client1" }; // Missing idx and uri

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Missing required fields: iss, idx, uri",
        }),
      });
    });

    it("should return 400 if URI format is invalid", async () => {
      const payload = { iss: "client1", idx: 123, uri: "invalid-uri-format" };

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Invalid URI format",
        }),
      });
    });

    it("should return 400 if list type indicator is invalid", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/x/3B0F3BD087A7",
      };

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Invalid list type in URI: must be /t/ or /b/",
        }),
      });
    });

    it("should return 404 if entry does not exist in database", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({ Item: undefined });

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "NOT_FOUND",
          error_description: "Entry not found in status list table",
        }),
      });
    });

    it("should return 404 for list type mismatch", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "BitstringStatusList" },
        },
      });

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "NOT_FOUND",
          error_description:
            "List type mismatch: Expected TokenStatusList but entry has BitstringStatusList",
        }),
      });
    });

    it("should return 404 for entry with undefined list type", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
        },
      });

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "NOT_FOUND",
          error_description:
            "List type mismatch: Expected TokenStatusList but entry has undefined",
        }),
      });
    });

    it("should return 400 if DynamoDB query fails", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient
        .on(GetItemCommand)
        .rejects(new Error("DynamoDB connection error"));

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Error processing revocation request",
        }),
      });
    });

    it("should return 400 if DynamoDB update fails", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient
        .on(UpdateItemCommand)
        .rejects(new Error("Update operation failed"));

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response).toStrictEqual({
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Error processing revocation request",
        }),
      });
    });
  });

  describe("logging functionality", () => {
    it("should setup logger correctly", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      const event = createTestEvent(payload);
      await handler(event, context);

      expect(logger.resetKeys).toHaveBeenCalledTimes(1);
      expect(logger.addContext).toHaveBeenCalledWith(context);
      expect(logger.appendKeys).toHaveBeenCalledWith({
        functionVersion: context.functionVersion,
      });
    });

    it("should log the handler being called", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      const event = createTestEvent(payload);
      await handler(event, context);

      expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_LAMBDA_CALLED);
    });

    it("should log successful operations appropriately", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/t/3B0F3BD087A7",
      };

      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      const event = createTestEvent(payload);
      await handler(event, context);

      expect(logger.info).toHaveBeenCalledWith("Successfully decoded payload");
      expect(logger.info).toHaveBeenCalledWith(
        "Found item in table: TokenStatusList 3B0F3BD087A7 123",
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Revocation process completed for URI 3B0F3BD087A7 and index 123. Already revoked: false",
      );
    });
  });
});
