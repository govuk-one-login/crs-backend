import { handler } from "../../../src/functions/revokeHandler";
import { logger } from "../../../src/common/logging/logger";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import { Context, APIGatewayProxyEvent } from "aws-lambda";
import { buildLambdaContext } from "../../utils/mockContext";
import { buildRequest } from "../../utils/mockRequest";
import { mockClient } from "aws-sdk-client-mock";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { sdkStreamMixin } from "@smithy/util-stream-node";
import { Readable } from "stream";
import {
  EMPTY_SIGNING_KEY,
  ISSUE_GOLDEN_JWT_TOKEN_LIST,
  ISSUE_JWT_WITH_NO_EXPIRES,
  ISSUE_JWT_WITH_NO_ISS,
  ISSUE_JWT_WITH_NO_JWKS_URI,
  ISSUE_JWT_WITH_NO_KID,
  ISSUE_JWT_WITH_NON_MATCHING_CLIENT_ID,
  ISSUE_JWT_WITH_NON_MATCHING_KID,
  ISSUE_JWT_WITH_NON_VERIFIED_SIGNATURE,
  JWKS_SIGNING_KEY,
  PUBLIC_KEY,
  REVOKE_GOLDEN_JWT,
  REVOKE_JWT_WITH_NO_CLIENT_ID,
  REVOKE_JWT_WITH_NO_INDEX,
  REVOKE_JWT_WITH_NO_JWKS_URI,
  REVOKE_JWT_WITH_NO_KID,
  REVOKE_JWT_WITH_NO_URI,
  REVOKE_JWT_WITH_NON_MATCHING_CLIENT_ID,
  REVOKE_JWT_WITH_NON_MATCHING_KID,
  REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE,
  TEST_CLIENT_ID,
  TEST_KID,
  TEST_NON_MATCHING_KID,
} from "../../utils/testConstants";
import { importSPKI } from "jose";
import * as jose from "jose";
import { describe, expect } from "@jest/globals";
import mock = jest.mock;

// Mock the logger
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

describe("revoke handler", () => {
  const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
  const mockContext = buildLambdaContext();

  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Client.reset();
    mockDBClient.reset();

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
        clientId: { S: "DNkekdNSkekSNljrwevOIUPenGeS" },
        issuedAt: { N: String(Date.now()) },
        listType: { S: "BitstringStatusList" },
      },
    });

    jest.spyOn(jose, "importJWK").mockResolvedValue(importedPublicKey);
  });

  describe("Golden Path", () => {
    it("should return correct status, headers and message in response body", async () => {
      const response = await handler(mockEvent, mockContext);
      const body = JSON.parse(response.body);

      expect(body).toEqual({ message: "Request accepted for revocation" });
      expect(response.statusCode).toBe(202);
      expect(response.headers).toEqual({ "Content-Type": "application/json" });
    });

    it("should setup logger with context", async () => {
      await handler(mockEvent, mockContext);

      expect(logger.resetKeys).toHaveBeenCalledTimes(1);
      expect(logger.addContext).toHaveBeenCalledWith(mockContext);
      expect(logger.appendKeys).toHaveBeenCalledWith({
        functionVersion: mockContext.functionVersion,
      });
    });

    it("should log the handler being called", async () => {
      await handler(mockEvent, mockContext);

      expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_LAMBDA_CALLED);
    });
  });

  describe("Bad Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_KID }),
        "No Kid in Header",
        REVOKE_JWT_WITH_NO_KID,
        "null",
        TEST_CLIENT_ID,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_INDEX }),
        "No Index in Payload",
        REVOKE_JWT_WITH_NO_INDEX,
        TEST_KID,
        TEST_CLIENT_ID,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_URI }),
        "No URI in Payload",
        REVOKE_JWT_WITH_NO_URI,
        TEST_KID,
        "",
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NO_CLIENT_ID }),
        "No Issuer in Payload",
        REVOKE_JWT_WITH_NO_CLIENT_ID,
        TEST_KID,
        "",
      ],
    ])(
      "Returns 400 with correct descriptions",
      async (event, errorDescription) => {
        const result = await handler(event, mockContext);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 400,
          body: JSON.stringify({
            error: "BAD_REQUEST",
            error_description: errorDescription,
          }),
        });
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
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NON_MATCHING_KID }),
        `No matching Key ID found in JWKS Endpoint for Kid: ${TEST_NON_MATCHING_KID}`,
      ],
      [
        buildRequest({ body: REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE }),
        "Failure verifying the signature of the jwt",
      ],
    ])(
      "Returns 401 with correct descriptions",
      async (event, errorDescription) => {
        const result = await handler(event, mockContext);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 401,
          body: JSON.stringify({
            error: "UNAUTHORISED",
            error_description: errorDescription,
          }),
        });
      },
    );
    it("Returns 401 error when credential to revoke has different clientId than request", async () => {
      mockDBClient.on(GetItemCommand).resolves({
        Item: {
          uri: { S: "B2757C3F6091" },
          idx: { N: "1680" },
          clientId: { S: "NONEXISTANT" },
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
    });
  });

  describe("Internal Server Error Scenarios", () => {
    it("Returns 500 error when no JWKSUri found on matchingClient in registry", async () => {
      const event = buildRequest({ body: REVOKE_JWT_WITH_NO_JWKS_URI });
      const result = await handler(event, mockContext);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 500,
        body: JSON.stringify({
          error: "INTERNAL_SERVER_ERROR",
          error_description: "No jwksUri found on client ID: mockClientId",
        }),
      });
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
    });
  });
});
