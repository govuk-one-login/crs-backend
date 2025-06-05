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

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.message).toBe("Request accepted for revocation");
      expect(body.revokedAt).toBeDefined();
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

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.message).toBe("Request accepted for revocation");
      expect(body.revokedAt).toBeDefined();
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

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe("Credential already revoked");
      expect(body.revokedAt).toBe("1640995200");
      expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
      expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });
  });

  describe("error scenarios", () => {
    it("should return 400 if request body is missing", async () => {
      const event = { ...buildRequest(), body: null };
      const response = await handler(event, context);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("BAD_REQUEST");
      expect(JSON.parse(response.body).error_description).toBe(
        "No Request Body Found",
      );
    });

    it("should return 400 if payload cannot be parsed", async () => {
      const event = { ...buildRequest(), body: "invalid-json" };
      const response = await handler(event, context);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("BAD_REQUEST");
      expect(JSON.parse(response.body).error_description).toBe(
        "Error decoding payload",
      );
    });

    it("should return 400 for missing required fields", async () => {
      const payload = { iss: "client1" }; // Missing idx and uri

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("BAD_REQUEST");
      expect(JSON.parse(response.body).error_description).toBe(
        "Missing required fields: iss, idx, uri",
      );
    });

    it("should return 400 if URI format is invalid", async () => {
      const payload = { iss: "client1", idx: 123, uri: "invalid-uri-format" };

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_description).toBe(
        "Invalid URI format",
      );
    });

    it("should return 400 if list type indicator is invalid", async () => {
      const payload = {
        iss: "client1",
        idx: 123,
        uri: "https://dummy-uri/x/3B0F3BD087A7",
      };

      const event = createTestEvent(payload);
      const response = await handler(event, context);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_description).toBe(
        "Invalid list type in URI: must be /t/ or /b/",
      );
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

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("NOT_FOUND");
      expect(JSON.parse(response.body).error_description).toBe(
        "Entry not found in status list table",
      );
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

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe("NOT_FOUND");
      expect(JSON.parse(response.body).error_description).toContain(
        "List type mismatch",
      );
      expect(JSON.parse(response.body).error_description).toContain(
        "Expected TokenStatusList but entry has BitstringStatusList",
      );
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

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_description).toContain(
        "Expected TokenStatusList but entry has undefined",
      );
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

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("BAD_REQUEST");
      expect(JSON.parse(response.body).error_description).toBe(
        "Error processing revocation request",
      );
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

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("BAD_REQUEST");
      expect(JSON.parse(response.body).error_description).toBe(
        "Error processing revocation request",
      );
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
