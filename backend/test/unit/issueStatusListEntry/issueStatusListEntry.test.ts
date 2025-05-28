import {
  handler,
  PUBLIC_KEY,
} from "../../../src/functions/issueStatusListEntryHandler";
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
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream-node";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

const mockS3Client = mockClient(S3Client);
const mockSQSClient = mockClient(SQSClient);
const mockDBClient = mockClient(DynamoDBClient);

const TEST_KID = "cc2c3738-03ec-4214-a65e-7f0461a34e7b";
const TEST_CLIENT_ID = "DNkekdNSkekSNljrwevOIUPenGeS";
const GOLDEN_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJpc3MiOiJhc0tXbnNqZUVKRVdqandTSHNJa3NJa3NJaEJlIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.OlAm7TIfn-Qrs2yJvl6MDr9raiq_uZ6FV7WwaPz2CTuCuK-EkvsqM8139yjIiJq3pqeZk0S_23J-4SGBAkUXhA";
const GOLDEN_JWT_TOKEN_LIST =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.TAAkC2SxFnVKPzaZkZW2zbQWcQoA0iNP_cmpD4OY6JR-Bf2sF4OWk0SRgUIz-mmuwaheZ1Zny2g_yhvHCZXnuA";
const JWT_WITH_NO_EXPIRES =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIn0.2Uqks9_0pF6OI-297ihGZn_ym0IVRraVIcLyGeHDak_YwRjCUUvHY-vlI1_8hLTSF4xK2KHVnq9Xm2w2ps6Spg";
const JWT_WITH_NO_KID =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.RoM7Z-Ir0yKPTSqEyN0pbThdmEHL-cwxMUb_lZw-ZgSdRSbfWQBLdCg6L0lT_GG-o7_LEyFitmiX-Ya_jKe20g";
const JWT_WITH_NO_ISS =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJleHBpcmVzIjoiMTczNDcwOTQ5MyJ9.fn_1wkH1EgufA1U3sKHSVpfpYOmxPVC4_b8NHPe_YKQr5QNqP1NQHaWL56cXpL38Tfo6i4c2YKmJwmdpQkS5Kw";
const JWT_WITH_NON_MATCHING_CLIENT_ID =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjFmYjJjMGYwN2Y2NDNiNDVjYWZlYjUzZmI5ZDllYjM0In0.eyJpc3MiOiJEQWtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.XSos0P9wZYV_QEzKe6UFpVrn-D2_1oK6emDyrix_cXGSg5gS1cu2l7rImGDZ_DOgZlqsNzj1KbQbjvRFFSAhjw";
const JWT_WITH_NON_MATCHING_KID =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjFmYjJjMGYwN2Y2NDNiNDVjYWZlYjUzZmI5ZDllYjM0In0.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.BLL1kOTPZFI8gfYZZghPO65oipEnRBVefAqobZ3RmI9E14vB-l9taEAdgVKKyBVQe6XIRSuhsXC6Nv5UDBt57A";
const JWT_WITH_NO_JWKS_URI =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJpc3MiOiJtb2NrQ2xpZW50SWQiLCJleHBpcmVzIjoiMTczNDcwOTQ5MyJ9.y10ELWBHxVFiw8YZwbqiDdF4PC4rR95P9me-qK8pLlYeKh5VO7EtrspkCANKoM92EC6pysc9ymt5CpeTTiVB5w";

describe("Testing IssueStatusListEntry Lambda", () => {
  let consoleInfoSpy: jest.SpyInstance;
  let result: APIGatewayProxyResult;
  let context: Context;
  let event: APIGatewayProxyEvent;

  beforeEach(() => {
    mockS3Client.reset();
    mockSQSClient.reset();
    mockDBClient.reset();
    consoleInfoSpy = jest.spyOn(console, "info");
    context = buildLambdaContext();
    event = buildRequest();

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

    mockSQSClient
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [
          {
            Body: JSON.stringify({
              idx: 4,
              uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF",
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
              uri: "https://douglast-backend.crs.dev.account.gov.uk/b/BAT1FED3E9AF",
            }),
            ReceiptHandle: "mockReceiptHandle",
          },
        ],
      });

    mockDBClient.on(GetItemCommand).resolves({
      Item: undefined,
    });
  });

  describe("On every invocation", () => {
    it("logs STARTED message", async () => {
      result = await handler(event, context);
      expect(consoleInfoSpy).toHaveBeenCalledWithLogFields({
        messageCode: "ISSUE_LAMBDA_STARTED",
      });
    });

    it("Clears pre-existing log attributes", async () => {
      logger.appendKeys({ testKey: "testValue" });
      result = await handler(event, context);

      expect(consoleInfoSpy).not.toHaveBeenCalledWithLogFields({
        testKey: "testValue",
      });
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
          uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF",
        }),
      });

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;
      assertAndValidateIssuedTXMAEvent(sqsMessageBody);

      const dbItem =
        mockDBClient.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(dbItem).toEqual(
        createTestDBItem(
          "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF",
          "4",
        ),
      );
    });
    it("Returns 200,successful audit event, no existing index, token status list", async () => {
      Date.now = jest.fn(() => new Date(Date.UTC(2017, 1, 14)).valueOf());
      event = buildRequest(buildRequest({ body: GOLDEN_JWT_TOKEN_LIST }));
      result = await handler(event, context);

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idx: 4,
          uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF",
        }),
      });

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;
      assertAndValidateIssuedTXMAEvent(
        sqsMessageBody,
        undefined,
        undefined,
        '"client_id":"DNkekdNSkekSNljrwevOIUPenGeS"',
        GOLDEN_JWT_TOKEN_LIST,
      );

      const dbItem =
        mockDBClient.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(dbItem).toEqual(
        createTestDBItem(
          "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF",
          "4",
          "DNkekdNSkekSNljrwevOIUPenGeS",

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
          uri: "https://douglast-backend.crs.dev.account.gov.uk/b/BAT1FED3E9AF",
        }),
      });

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;
      assertAndValidateIssuedTXMAEvent(
        sqsMessageBody,
        '"index":2',
        '"https://douglast-backend.crs.dev.account.gov.uk/b/BAT1FED3E9AF"',
        '"client_id":"asKWnsjeEJEWjjwSHsIksIksIhBe"',
        GOLDEN_JWT,
      );

      const dbItem =
        mockDBClient.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(dbItem).toEqual(
        createTestDBItem(
          "https://douglast-backend.crs.dev.account.gov.uk/b/BAT1FED3E9AF",
          "2",
        ),
      );
    });
  });

  describe("Bad Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: JWT_WITH_NO_EXPIRES }),
        "No Expiry Date in Payload",
        JWT_WITH_NO_EXPIRES,
        TEST_KID,
        TEST_CLIENT_ID,
      ],
      [
        buildRequest({ body: JWT_WITH_NO_KID }),
        "No Kid in Header",
        JWT_WITH_NO_KID,
        "null",
        TEST_CLIENT_ID,
      ],
      [
        buildRequest({ body: JWT_WITH_NO_ISS }),
        "No Issuer in Payload",
        JWT_WITH_NO_ISS,
        TEST_KID,
        "",
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
          PUBLIC_KEY,
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
          error_description: "No Request Body Found",
        }),
      });

      expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
    });
  });

  describe("Unauthorized Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: JWT_WITH_NON_MATCHING_CLIENT_ID }),
        "No matching client found with ID: DAkekdNSkekSNljrwevOIUPenGeS",
        JWT_WITH_NON_MATCHING_CLIENT_ID,
        "DAkekdNSkekSNljrwevOIUPenGeS",
      ],
      [
        buildRequest({ body: JWT_WITH_NON_MATCHING_KID }),
        "No matching Key ID found in JWKS Endpoint for Kid: 1fb2c0f07f643b45cafeb53fb9d9eb34",
        JWT_WITH_NON_MATCHING_KID,
        TEST_CLIENT_ID,
      ],
    ])(
      "Returns 401 with correct descriptions",
      async (event, errorDescription, request: string, clientId: string) => {
        result = await handler(event, context);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 401,
          body: JSON.stringify({
            error: "UNAUTHORISED",
            error_description: errorDescription,
          }),
        });
        assertAndValidateErrorTXMAEvent(
          clientId,
          "CRS_ISSUANCE_FAILED",
          PUBLIC_KEY,
          "1fb2c0f07f643b45cafeb53fb9d9eb34",
          request,
          "401",
          "UNAUTHORISED",
        );
        expect(mockDBClient.commandCalls(PutItemCommand)).toHaveLength(0);
      },
    );
  });

  describe("Internal Server Error Scenarios", () => {
    it("Returns 500 and the error description", async () => {
      event = buildRequest({ body: JWT_WITH_NO_JWKS_URI });
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
        PUBLIC_KEY,
        TEST_KID,
        JWT_WITH_NO_JWKS_URI,
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
  uri: string = '"uri":"https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AF"',
  clientId: string = '"client_id":"asKWnsjeEJEWjjwSHsIksIksIhBe"',
  jwtRequest: string = GOLDEN_JWT,
) {
  expect(mockSQSClient.commandCalls(SendMessageCommand)).toHaveLength(1);
  expect(sqsMessageBody).toContain(clientId);
  expect(sqsMessageBody).toContain("CRS_INDEX_ISSUED");
  expect(sqsMessageBody).toContain(PUBLIC_KEY);
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
