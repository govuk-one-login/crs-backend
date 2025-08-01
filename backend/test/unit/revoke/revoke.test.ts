import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

process.env.STATUS_LIST_TABLE = "StatusListTable";
import { handler } from "../../../src/functions/revokeHandler";
import { logger } from "../../../src/common/logging/logger";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { buildLambdaContext } from "../../utils/mockContext";
import { buildRequest } from "../../utils/mockRequest";
import { describe, expect } from "@jest/globals";
import {
  EMPTY_SIGNING_KEY,
  JWKS_SIGNING_KEY,
  PUBLIC_KEY,
  REVOKE_GOLDEN_JWT,
  REVOKE_GOLDEN_TOKEN_JWT,
  REVOKE_JWT_WITH_INVALID_LIST_TYPE,
  REVOKE_JWT_WITH_INVALID_URI,
  REVOKE_JWT_WITH_NO_CLIENT_ID,
  REVOKE_JWT_WITH_NO_IAT,
  REVOKE_JWT_WITH_NO_INDEX,
  REVOKE_JWT_WITH_NO_JWKS_URI,
  REVOKE_JWT_WITH_NO_KID,
  REVOKE_JWT_WITH_NO_TYP,
  REVOKE_JWT_WITH_NO_URI,
  REVOKE_JWT_WITH_NON_MATCHING_CLIENT_ID,
  REVOKE_JWT_WITH_NON_MATCHING_KID,
  REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE,
  REVOKE_JWT_WITH_INVALID_TYP,
  REVOKE_JWT_WITH_WRONG_ALG,
  TEST_CLIENT_ID_BITSTRING,
  TEST_CLIENT_ID_TOKEN,
  TEST_KID,
  TEST_NON_MATCHING_KID,
} from "../../utils/testConstants";
import { importSPKI } from "jose";
import * as jose from "jose";
import { sdkStreamMixin } from "@smithy/util-stream-node";
import { Readable } from "stream";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

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

const mockS3Client = mockClient(S3Client);
const mockDBClient = mockClient(DynamoDBClient);
const mockSQSClient = mockClient(SQSClient);

describe("Testing Revoke Lambda", () => {
  const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
  const mockContext = buildLambdaContext();
  let loggerInfoSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    loggerInfoSpy = jest.spyOn(logger, "info");
    mockDBClient.reset();
    mockS3Client.reset();
    mockSQSClient.reset();

    const importedPublicKey = importSPKI(PUBLIC_KEY, "ES256");

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(
        Readable.from([
          JSON.stringify({
            clients: [
              {
                clientName: "OVA",
                clientId: "asKWnsjeEJEWjjwSHsIksIksIhBe",
                statusList: {
                  jwksUri:
                    "https://mobile.dev.account.gov.uk/.well-known/jwks.json",
                  type: "BitstringStatusList",
                  format: "vc+jwt",
                },
              },
              {
                clientName: "DVLA",
                clientId: "DNkekdNSkekSNljrwevOIUPenGeS",
                statusList: {
                  jwksUri:
                    "https://mobile.dev.account.gov.uk/.well-known/jwks.json",
                  type: "TokenStatusList",
                  format: "statuslist+jwt",
                },
              },
              {
                clientName: "MOCK-WITH-NO-URI",
                clientId: "mockClientId",
                statusList: {
                  jwksUri: "",
                  type: "TokenStatusList",
                  format: "statuslist+jwt",
                },
              },
            ],
          }),
        ]),
      ),
    });

    mockDBClient.on(GetItemCommand).resolves({
      Item: {
        uri: { S: "B2757C3F6091" },
        idx: { N: "1680" },
        clientId: { S: TEST_CLIENT_ID_BITSTRING },
        issuedAt: { N: String(Date.now()) },
        listType: { S: "BitstringStatusList" },
      },
    });

    jest.spyOn(jose, "importJWK").mockResolvedValue(importedPublicKey);
  });

  describe("On every invocation", () => {
    it("logs STARTED message and COMPLETED message", async () => {
      await handler(mockEvent, mockContext);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_COMPLETED,
      );
    });
  });

  describe("successful revocation scenarios", () => {
    it("should return 202 revoke success with BitStringStatusList", async () => {
      mockDBClient.on(UpdateItemCommand).resolves({});

      const response = await handler(mockEvent, mockContext);

      // Parse response body to extract timestamp
      const responseBody = JSON.parse(response.body);

      expect(response).toStrictEqual({
        statusCode: 202,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Request processed for revocation",
          revokedAt: responseBody.revokedAt,
        }),
      });

      assertAndValidateRevokeSuccessTXMAEvent();

      // Additional validation for timestamp format
      expect(responseBody.revokedAt).toMatch(/^\d+$/);
      expect(parseInt(responseBody.revokedAt)).toBeGreaterThan(0);

      expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
      expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(1);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_COMPLETED,
      );
    });

    it("should return 202 revoke success with TokenStatusList", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          clientId: { S: "DNkekdNSkekSNljrwevOIUPenGeS" },
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "456" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      const event = buildRequest({ body: REVOKE_GOLDEN_TOKEN_JWT });
      const response = await handler(event, mockContext);
      const responseBody = JSON.parse(response.body);

      expect(response).toStrictEqual({
        statusCode: 202,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Request processed for revocation",
          revokedAt: responseBody.revokedAt,
        }),
      });

      // Additional validation for timestamp format
      expect(responseBody.revokedAt).toMatch(/^\d+$/);
      expect(parseInt(responseBody.revokedAt)).toBeGreaterThan(0);

      assertAndValidateRevokeSuccessTXMAEvent(
        TEST_CLIENT_ID_TOKEN,
        REVOKE_GOLDEN_TOKEN_JWT,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_COMPLETED,
      );
    });

    it("should return 202 OK for already revoked credential", async () => {
      //Using the same payload as REVOKE_GOLDEN_TOKEN_JWT, but updating the mock to simulate already revoked state
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          clientId: { S: "DNkekdNSkekSNljrwevOIUPenGeS" },
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "456" },
          listType: { S: "TokenStatusList" },
          revokedAt: { N: "1640995200" },
        },
      });

      const event = buildRequest({ body: REVOKE_GOLDEN_TOKEN_JWT });
      const response = await handler(event, mockContext);

      expect(response).toStrictEqual({
        statusCode: 202,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Credential already revoked",
          revokedAt: "1640995200",
        }),
      });

      expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
      expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(0);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_COMPLETED,
      );

      assertAndValidateRevokeSuccessTXMAEvent(
        TEST_CLIENT_ID_TOKEN,
        REVOKE_GOLDEN_TOKEN_JWT,
      );
    });
  });

  describe("Bad Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_TYP }),
        "No Type in Header",
        REVOKE_JWT_WITH_NO_TYP,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_INVALID_TYP }),
        "Invalid Type in Header",
        REVOKE_JWT_WITH_INVALID_TYP,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_WRONG_ALG }),
        "Invalid Algorithm in Header",
        REVOKE_JWT_WITH_WRONG_ALG,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_KID }),
        "No Kid in Header",
        REVOKE_JWT_WITH_NO_KID,
        "null",
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_IAT }),
        "No IssuedAt in Payload",
        REVOKE_JWT_WITH_NO_IAT,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_INDEX }),
        "No Index in Payload",
        REVOKE_JWT_WITH_NO_INDEX,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_URI }),
        "No URI in Payload",
        REVOKE_JWT_WITH_NO_URI,
        TEST_KID,
        "",
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_CLIENT_ID }),
        "No Issuer in Payload",
        REVOKE_JWT_WITH_NO_CLIENT_ID,
        TEST_KID,
        "",
        EMPTY_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_INVALID_URI }),
        "Invalid URI format",
        REVOKE_JWT_WITH_INVALID_URI,
        TEST_KID,
        "",
        JWKS_SIGNING_KEY,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_INVALID_LIST_TYPE }),
        "Invalid list type in URI: must be /t/ or /b/",
        REVOKE_JWT_WITH_INVALID_LIST_TYPE,
        TEST_KID,
        "",
        JWKS_SIGNING_KEY,
      ],
    ])(
      "Returns 400 with correct descriptions",
      async (event, errorDescription, request, kid, clientId, signingKey) => {
        const result = await handler(event, mockContext);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 400,
          body: JSON.stringify({
            error: "BAD_REQUEST",
            error_description: errorDescription,
          }),
        });

        assertAndValidateRevokeErrorTXMAEvent(
          clientId,
          "CRS_INDEX_REVOCATION_FAILED",
          signingKey,
          kid,
          request,
          "400",
          "BAD_REQUEST",
        );
      },
    );

    it("Returns 400 on a empty request body", async () => {
      const result = await handler(buildRequest({ body: null }), mockContext);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 400,
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "No Request Body Found",
        }),
      });
    });
  });

  describe("Unauthorized Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: REVOKE_JWT_WITH_NON_MATCHING_CLIENT_ID }),
        "No matching client found with ID: asvvnsjeEJEWjjwSHsIksIksIhBe ",
        REVOKE_JWT_WITH_NON_MATCHING_CLIENT_ID,
        TEST_KID,
        "asvvnsjeEJEWjjwSHsIksIksIhBe",
        EMPTY_SIGNING_KEY,
        401,
        "UNAUTHORISED",
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NON_MATCHING_KID }),
        `No matching Key ID found in JWKS Endpoint for Kid: ${TEST_NON_MATCHING_KID}`,
        REVOKE_JWT_WITH_NON_MATCHING_KID,
        TEST_NON_MATCHING_KID,
        TEST_CLIENT_ID_BITSTRING,
        EMPTY_SIGNING_KEY,
        400,
        "BAD_REQUEST",
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE }),
        "Failure verifying the signature of the jwt",
        REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE,
        TEST_KID,
        TEST_CLIENT_ID_TOKEN,
        JWKS_SIGNING_KEY,
        403,
        "FORBIDDEN",
      ],
    ])(
      "Returns correct status codes with correct descriptions",
      async (
        event,
        errorDescription,
        request,
        kid,
        clientId,
        signingKey,
        expectedStatusCode,
        expectedError,
      ) => {
        const result = await handler(event, mockContext);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: expectedStatusCode,
          body: JSON.stringify({
            error: expectedError,
            error_description: errorDescription,
          }),
        });

        assertAndValidateRevokeErrorTXMAEvent(
          clientId,
          "CRS_INDEX_REVOCATION_FAILED",
          signingKey,
          kid,
          request,
          expectedStatusCode.toString(),
          expectedError,
        );
      },
    );

    it("Returns 401 error when credential to revoke has different clientId than request", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "B2757C3F6091" },
          idx: { N: "1680" },
          clientId: { S: "NONEXISTENT" },
          issuedAt: { N: String(Date.now()) },
          listType: { S: "BitstringStatusList" },
        },
      });

      const event = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const result = await handler(event, mockContext);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 401,
        body: JSON.stringify({
          error: "UNAUTHORISED",
          error_description:
            "The original clientId is different to the clientId in the request",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_JWT,
        "401",
        "UNAUTHORISED",
      );
    });
  });

  describe("Not Found Error Scenarios", () => {
    it("should return 404 if entry does not exist in database", async () => {
      mockDBClient.on(GetItemCommand).resolves({ Item: undefined });

      const response = await handler(mockEvent, mockContext);

      expect(response).toStrictEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "NOT_FOUND",
          error_description: "Entry not found in status list table",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_JWT,
        "404",
        "NOT_FOUND",
      );
    });

    it("should return 404 for list type mismatch", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });

      const result = await handler(mockEvent, mockContext);

      expect(result).toStrictEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "NOT_FOUND",
          error_description:
            "List type mismatch: Expected BitstringStatusList but entry has TokenStatusList",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_JWT,
        "404",
        "NOT_FOUND",
      );
    });

    it("should return 404 for entry with undefined list type", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
        },
      });

      const response = await handler(mockEvent, mockContext);

      expect(response).toStrictEqual({
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "NOT_FOUND",
          error_description:
            "List type mismatch: Expected BitstringStatusList but entry has undefined",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_JWT,
        "404",
        "NOT_FOUND",
      );
    });
  });

  describe("Internal Server Error Scenarios", () => {
    it("Returns 500 error when no JWKSUri found on matchingClient in registry", async () => {
      const event = buildRequest({ body: REVOKE_JWT_WITH_NO_JWKS_URI });
      const result = await handler(event, mockContext);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 500,
        body: JSON.stringify({
          error: "INTERNAL_SERVER_ERROR",
          error_description: "No jwksUri found on client ID: mockClientId",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        "mockClientId",
        "CRS_INDEX_REVOCATION_FAILED",
        EMPTY_SIGNING_KEY,
        TEST_NON_MATCHING_KID,
        REVOKE_JWT_WITH_NO_JWKS_URI,
        "500",
        "INTERNAL_SERVER_ERROR",
      );
    });

    it("Returns 500 error when no clientId exists on credential", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "B2757C3F6091" },
          idx: { N: "1680" },
          issuedAt: { N: String(Date.now()) },
          listType: { S: "BitstringStatusList" },
        },
      });

      const event = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const result = await handler(event, mockContext);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 500,
        body: JSON.stringify({
          error: "INTERNAL_SERVER_ERROR",
          error_description:
            "No client ID found on item index: 1680 and uri: B2757C3F6091",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_JWT,
        "500",
        "INTERNAL_SERVER_ERROR",
      );
    });

    it("should return 500 if DynamoDB query fails", async () => {
      mockDBClient
        .on(GetItemCommand)
        .rejects(new Error("DynamoDB connection error"));

      const response = await handler(mockEvent, mockContext);

      expect(response).toStrictEqual({
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "INTERNAL_SERVER_ERROR",
          error_description:
            "Error querying database: Error: DynamoDB connection error",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_JWT,
        "500",
        "INTERNAL_SERVER_ERROR",
      );
    });

    it("should return 500 if DynamoDB update fails", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          clientId: { S: TEST_CLIENT_ID_TOKEN },
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient
        .on(UpdateItemCommand)
        .rejects(new Error("Update operation failed"));

      const response = await handler(
        buildRequest({ body: REVOKE_GOLDEN_TOKEN_JWT }),
        mockContext,
      );

      expect(response).toStrictEqual({
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "INTERNAL_SERVER_ERROR",
          error_description: "Error processing revocation request",
        }),
      });

      assertAndValidateRevokeErrorTXMAEvent(
        TEST_CLIENT_ID_TOKEN,
        "CRS_INDEX_REVOCATION_FAILED",
        JWKS_SIGNING_KEY,
        TEST_KID,
        REVOKE_GOLDEN_TOKEN_JWT,
        "500",
        "INTERNAL_SERVER_ERROR",
      );
    });
  });

  describe("Logging Functionality", () => {
    it("should setup logger correctly", async () => {
      await handler(mockEvent, mockContext);

      expect(logger.resetKeys).toHaveBeenCalledTimes(1);
      expect(logger.addContext).toHaveBeenCalledWith(mockContext);
      expect(logger.appendKeys).toHaveBeenCalledWith({
        functionVersion: mockContext.functionVersion,
      });
    });

    it("should log the handler being called", async () => {
      const response = await handler(mockEvent, mockContext);
      const responseBody = JSON.parse(response.body);

      expect(response).toStrictEqual({
        statusCode: 202,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Request processed for revocation",
          revokedAt: responseBody.revokedAt,
        }),
      });
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
    });

    it("should log the handler being called", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "TokenStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      await handler(mockEvent, mockContext);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
    });

    it("should log successful operations appropriately", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          clientId: { S: TEST_CLIENT_ID_BITSTRING },
          uri: { S: "3B0F3BD087A7" },
          idx: { N: "123" },
          listType: { S: "BitstringStatusList" },
        },
      });
      mockDBClient.on(UpdateItemCommand).resolves({});

      await handler(mockEvent, mockContext);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.REVOKE_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        "Succesfully decoded JWT as JSON",
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        "Updating revokedAt field in DynamoDB",
      );
      expect(loggerInfoSpy).toHaveBeenCalledTimes(9);
    });
  });
});

function assertAndValidateRevokeErrorTXMAEvent(
  clientId: string,
  eventName: string,
  signingKey: string,
  kid: string | null,
  jwtRequest: string | null,
  statusCode: string,
  error: string,
) {
  const sqsMessageBody =
    mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody;
  expect(mockSQSClient.commandCalls(SendMessageCommand)).toHaveLength(1);
  expect(sqsMessageBody).toContain(clientId);
  expect(sqsMessageBody).toContain(eventName);
  expect(sqsMessageBody).toContain(signingKey);
  expect(sqsMessageBody).toContain(kid);
  expect(sqsMessageBody).toContain(jwtRequest);
  expect(sqsMessageBody).toContain(statusCode);
  expect(sqsMessageBody).toContain(error);
}

function assertAndValidateRevokeSuccessTXMAEvent(
  clientId: string = '"client_id":"asKWnsjeEJEWjjwSHsIksIksIhBe"',
  jwtRequest: string = REVOKE_GOLDEN_JWT,
) {
  const sqsMessageBody =
    mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody;

  expect(mockSQSClient.commandCalls(SendMessageCommand)).toHaveLength(1);
  expect(sqsMessageBody).toContain(clientId);
  expect(sqsMessageBody).toContain("CRS_INDEX_REVOKED");
  expect(sqsMessageBody).toContain(JWKS_SIGNING_KEY);
  expect(sqsMessageBody).toContain(jwtRequest);
  expect(sqsMessageBody).toContain(
    '"keyId":"cc2c3738-03ec-4214-a65e-7f0461a34e7b"',
  );
}
