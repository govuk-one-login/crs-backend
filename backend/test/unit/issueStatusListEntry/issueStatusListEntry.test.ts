import { LogMessage } from "../../../src/common/logging/LogMessages";

process.env.BITSTRING_QUEUE_URL = "BitstringStatusList";
process.env.TOKEN_STATUS_QUEUE_URL = "TokenStatusList";

import { handler } from "../../../src/functions/issueStatusListEntryHandler";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { describe, expect } from "@jest/globals";
import { buildLambdaContext } from "../../utils/mockContext";
import "../../utils/matchers";
import { logger } from "../../../src/common/logging/logger";
import { buildRequest } from "../../utils/mockRequest";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream-node";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import * as jose from "jose";
import { importSPKI } from "jose";
import {
  JWKS_SIGNING_KEY,
  ISSUE_GOLDEN_JWT,
  ISSUE_GOLDEN_JWT_TOKEN_LIST,
  ISSUE_JWT_WITH_NO_EXPIRES,
  ISSUE_JWT_WITH_NO_ISS,
  ISSUE_JWT_WITH_NO_JWKS_URI,
  ISSUE_JWT_WITH_NO_KID,
  ISSUE_JWT_WITH_NON_MATCHING_CLIENT_ID,
  ISSUE_JWT_WITH_NON_MATCHING_KID,
  ISSUE_JWT_WITH_NON_VERIFIED_SIGNATURE,
  ISSUE_JWT_WITH_NO_TYP,
  ISSUE_JWT_WITH_INVALID_TYP,
  ISSUE_JWT_WITH_WRONG_ALG,
  PUBLIC_KEY,
  TEST_KID,
  TEST_NON_MATCHING_KID,
  EMPTY_SIGNING_KEY,
  TEST_CLIENT_ID_TOKEN,
  TEST_CLIENT_ID_BITSTRING,
  ISSUE_JWT_WITH_NON_NUMERIC_EXPIRES,
} from "../../utils/testConstants";
import https from "node:https";
import resetAllMocks = jest.resetAllMocks;

const mockS3Client = mockClient(S3Client);
const mockSQSClient = mockClient(SQSClient);
const mockDBClient = mockClient(DynamoDBClient);

describe("Testing IssueStatusListEntry Lambda", () => {
  let result: APIGatewayProxyResult;
  let context: Context;
  let event: APIGatewayProxyEvent;
  let loggerInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    mockS3Client.reset();
    mockSQSClient.reset();
    mockDBClient.reset();
    resetAllMocks();

    loggerInfoSpy = jest.spyOn(logger, "info");
    context = buildLambdaContext();
    event = buildRequest();

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
                clientName: "OVA",
                clientId: "asKWnsjeEJEWjjwSHsIksIksIhBe-TEST",
                statusList: {
                  jwksUri:
                    "https://mobile.dev.account.gov.uk/MOCK-WITH-FAILED-URI",
                  type: "BitStringStatusList",
                  format: "vc+jwt",
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

    mockSQSClient
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [
          {
            Body: JSON.stringify({
              idx: 4,
              uri: "A671FED3E9AF",
            }),
            ReceiptHandle: "mockReceiptHandle",
          },
        ],
      })
      .resolves({
        Messages: [
          {
            Body: JSON.stringify({
              idx: 2,
              uri: "BAT1FED3E9AF",
            }),
            ReceiptHandle: "mockReceiptHandle",
          },
        ],
      });

    mockDBClient.on(GetItemCommand).resolves({
      Item: undefined,
    });

    jest.spyOn(jose, "importJWK").mockResolvedValue(importedPublicKey);
  });

  describe("On every invocation", () => {
    it("logs STARTED message and COMPLETED message", async () => {
      result = await handler(event, context);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.ISSUE_STATUS_LIST_ENTRY_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.ISSUE_STATUS_LIST_ENTRY_LAMBDA_COMPLETED,
      );
    });
  });

  describe("Golden Path", () => {
    it("Returns 200 and the session details and successful audit event, no existing index", async () => {
      Date.now = jest.fn(() => new Date(Date.UTC(2017, 1, 14)).valueOf());

      result = await handler(event, context);

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idx: 4,
          uri: "https://api.status-list.service.gov.uk/b/A671FED3E9AF",
        }),
      });

      expect(logger.info).toHaveBeenCalledWith(
        LogMessage.ISSUE_STATUS_LIST_ENTRY_LAMBDA_STARTED,
      );
      expect(logger.info).toHaveBeenCalledWith(
        LogMessage.ISSUE_STATUS_LIST_ENTRY_LAMBDA_COMPLETED,
      );

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;
      assertAndValidateIssuedTXMAEvent(sqsMessageBody);

      const dbItem =
        mockDBClient.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(dbItem).toEqual(createTestDBItem("A671FED3E9AF", "4"));
    });
    it("Returns 200,successful audit event, no existing index, token status list", async () => {
      Date.now = jest.fn(() => new Date(Date.UTC(2017, 1, 14)).valueOf());
      event = buildRequest({ body: ISSUE_GOLDEN_JWT_TOKEN_LIST });
      result = await handler(event, context);

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idx: 4,
          uri: "https://api.status-list.service.gov.uk/t/A671FED3E9AF",
        }),
      });

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.ISSUE_STATUS_LIST_ENTRY_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.ISSUE_STATUS_LIST_ENTRY_LAMBDA_COMPLETED,
      );

      assertAndValidateIssuedTXMAEvent(
        sqsMessageBody,
        '"index":4',
        "https://api.status-list.service.gov.uk/t/A671FED3E9AF",
        '"client_id":"DNkekdNSkekSNljrwevOIUPenGeS"',
        ISSUE_GOLDEN_JWT_TOKEN_LIST,
      );

      const dbItem =
        mockDBClient.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(dbItem).toEqual(
        createTestDBItem(
          "A671FED3E9AF",
          "4",
          TEST_CLIENT_ID_TOKEN,
          "TokenStatusList",
          "DVLA",
        ),
      );
    });
    it("Available index already used, finds another, returns 200 and successful event", async () => {
      Date.now = jest.fn(() => new Date(Date.UTC(2017, 1, 14)).valueOf());

      mockDBClient
        .on(GetItemCommand)
        .resolvesOnce({
          Item: {
            uri: {
              S: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF",
            },
            idx: { N: "4" },
          },
        })
        .resolves({
          Item: undefined,
        });

      result = await handler(event, context);

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idx: 2,
          uri: "https://api.status-list.service.gov.uk/b/BAT1FED3E9AF",
        }),
      });

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;
      assertAndValidateIssuedTXMAEvent(
        sqsMessageBody,
        '"index":2',
        '"https://api.status-list.service.gov.uk/b/BAT1FED3E9AF"',
        '"client_id":"asKWnsjeEJEWjjwSHsIksIksIhBe"',
        ISSUE_GOLDEN_JWT,
      );

      const dbItem =
        mockDBClient.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(dbItem).toEqual(createTestDBItem("BAT1FED3E9AF", "2"));
    });
  });

  describe("Bad Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: ISSUE_JWT_WITH_NO_EXPIRES }),
        "No Expiry Date in Payload",
        ISSUE_JWT_WITH_NO_EXPIRES,
        TEST_KID,
        TEST_CLIENT_ID_TOKEN,
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_NON_NUMERIC_EXPIRES }),
        "Expiry Date in Payload must be a number",
        ISSUE_JWT_WITH_NON_NUMERIC_EXPIRES,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_NO_KID }),
        "No Kid in Header",
        ISSUE_JWT_WITH_NO_KID,
        "null",
        TEST_CLIENT_ID_TOKEN,
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_NO_ISS }),
        "No Issuer in Payload",
        ISSUE_JWT_WITH_NO_ISS,
        TEST_KID,
        "",
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_NO_TYP }),
        "No Type in Header",
        ISSUE_JWT_WITH_NO_TYP,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_INVALID_TYP }),
        "Invalid Type in Header",
        ISSUE_JWT_WITH_INVALID_TYP,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_WRONG_ALG }),
        "Invalid Algorithm in Header",
        ISSUE_JWT_WITH_WRONG_ALG,
        TEST_KID,
        TEST_CLIENT_ID_BITSTRING,
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_NON_MATCHING_KID }),
        `No matching Key ID found in JWKS Endpoint for Kid: ${TEST_NON_MATCHING_KID}`,
        ISSUE_JWT_WITH_NON_MATCHING_KID,
        TEST_NON_MATCHING_KID,
        TEST_CLIENT_ID_TOKEN,
      ],
    ])(
      "Returns 400 with correct descriptions",
      async (event, errorDescription, request, kid, clientId: string) => {
        result = await handler(event, context);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 400,
          body: JSON.stringify({
            error: "BAD_REQUEST",
            error_description: errorDescription,
          }),
        });
        assertAndValidateErrorTXMAEvent(
          clientId,
          "CRS_ISSUANCE_FAILED",
          EMPTY_SIGNING_KEY,
          kid,
          request,
          "400",
          "BAD_REQUEST",
        );
        expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
      },
    );

    it("Returns 400 on a empty request body", async () => {
      result = await handler(buildRequest({ body: null }), context);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 400,
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "No Event Body or Headers Found",
        }),
      });

      expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it("Returns 400 on empty request headers", async () => {
      result = await handler(buildRequest({ headers: null }), context);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 400,
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "No Event Body or Headers Found",
        }),
      });

      expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it("Returns 400 on bad content-type header", async () => {
      result = await handler(
        buildRequest({
          headers: {
            Host: "api.status-list.service.gov.uk",
            Accept: "application/json",
            "Content-Type": "application/test",
          },
        }),
        context,
      );

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 400,
        body: JSON.stringify({
          error: "BAD_REQUEST",
          error_description: "Content-Type header must be application/jwt",
        }),
      });

      expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
    });
  });

  describe("Forbidden or Unauthorized Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: ISSUE_JWT_WITH_NON_MATCHING_CLIENT_ID }),
        "No matching client found with ID: DAkekdNSkekSNljrwevOIUPenGeS ",
        ISSUE_JWT_WITH_NON_MATCHING_CLIENT_ID,
        "DAkekdNSkekSNljrwevOIUPenGeS",
        TEST_NON_MATCHING_KID,
        EMPTY_SIGNING_KEY,
        401,
        "UNAUTHORISED",
      ],
      [
        buildRequest({ body: ISSUE_JWT_WITH_NON_VERIFIED_SIGNATURE }),
        "Failure verifying the signature of the jwt",
        ISSUE_JWT_WITH_NON_VERIFIED_SIGNATURE,
        TEST_CLIENT_ID_TOKEN,
        TEST_KID,
        JWKS_SIGNING_KEY,
        403,
        "FORBIDDEN",
      ],
    ])(
      "Returns correct status codes with correct descriptions",
      async (
        event,
        errorDescription,
        request: string,
        clientId: string,
        kid: string,
        signingKey: string,
        expectedStatusCode: number,
        expectedError: string,
      ) => {
        result = await handler(event, context);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: expectedStatusCode,
          body: JSON.stringify({
            error: expectedError,
            error_description: errorDescription,
          }),
        });
        assertAndValidateErrorTXMAEvent(
          clientId,
          "CRS_ISSUANCE_FAILED",
          signingKey,
          kid,
          request,
          expectedStatusCode.toString(),
          expectedError,
        );
        expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
      },
    );

    it("Returns 403 Forbidden when JWKS fetch fails", async () => {
      event = buildRequest({ body: ISSUE_GOLDEN_JWT });
      const httpsRequestSpy = jest
        .spyOn(https, "request")
        .mockImplementation(() => {
          throw new Error("Failure fetching jwks");
        });
      result = await handler(event, context);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 403,
        body: JSON.stringify({
          error: "FORBIDDEN",
          error_description:
            "Failed to fetch JWKS from URI: https://mobile.dev.account.gov.uk/.well-known/jwks.json, Error: Failure fetching jwks",
        }),
      });
      assertAndValidateErrorTXMAEvent(
        TEST_CLIENT_ID_BITSTRING,
        "CRS_ISSUANCE_FAILED",
        'signingKey"',
        TEST_KID,
        ISSUE_GOLDEN_JWT,
        "403",
        "FORBIDDEN",
      );
      expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
      httpsRequestSpy.mockRestore();
    });
  });

  describe("Internal Server Error Scenarios", () => {
    it("Returns 500 and the error description", async () => {
      event = buildRequest({ body: ISSUE_JWT_WITH_NO_JWKS_URI });
      result = await handler(event, context);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 500,
        body: JSON.stringify({
          error: "INTERNAL_SERVER_ERROR",
          error_description: "No jwksUri found on client ID: mockClientId",
        }),
      });
      assertAndValidateErrorTXMAEvent(
        "mockClientId",
        "CRS_ISSUANCE_FAILED",
        'signingKey"',
        TEST_KID,
        ISSUE_JWT_WITH_NO_JWKS_URI,
        "500",
        "INTERNAL_SERVER_ERROR",
      );
      expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
    });
  });
});

function assertAndValidateErrorTXMAEvent(
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

function assertAndValidateIssuedTXMAEvent(
  sqsMessageBody,
  index: string = '"index":4',
  uri: string = '"uri":"https://api.status-list.service.gov.uk/b/A671FED3E9AF"',
  clientId: string = TEST_CLIENT_ID_BITSTRING,
  jwtRequest: string = ISSUE_GOLDEN_JWT,
) {
  expect(mockSQSClient.commandCalls(SendMessageCommand)).toHaveLength(1);
  expect(sqsMessageBody).toContain(clientId);
  expect(sqsMessageBody).toContain("CRS_INDEX_ISSUED");
  expect(sqsMessageBody).toContain(JWKS_SIGNING_KEY);
  expect(sqsMessageBody).toContain(jwtRequest);
  expect(sqsMessageBody).toContain(index);
  expect(sqsMessageBody).toContain(uri);
  expect(sqsMessageBody).toContain(
    '"keyId":"cc2c3738-03ec-4214-a65e-7f0461a34e7b"',
  );
}

function createTestDBItem(
  uri: string,
  idx: string,
  clientId: string = "asKWnsjeEJEWjjwSHsIksIksIhBe",
  listType: string = "BitstringStatusList",
  issuer: string = "OVA",
) {
  return {
    uri: { S: uri },
    idx: { N: idx },
    issuedAt: { N: "1487030400000" },
    clientId: { S: clientId },
    exp: { N: "1734709493" },
    issuer: { S: issuer },
    listType: { S: listType },
  };
}
