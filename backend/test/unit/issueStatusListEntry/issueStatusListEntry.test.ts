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
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream-node";

const mockS3Client = mockClient(S3Client);
const mockSQSClient = mockClient(SQSClient);

const TEST_KID = "cc2c3738-03ec-4214-a65e-7f0461a34e7b";
const GOLDEN_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJpc3MiOiJhc0tXbnNqZUVKRVdqandTSHNJa3NJa3NJaEJlIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.OlAm7TIfn-Qrs2yJvl6MDr9raiq_uZ6FV7WwaPz2CTuCuK-EkvsqM8139yjIiJq3pqeZk0S_23J-4SGBAkUXhA";
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
    it("Returns 200 and the session details and sucessful audit event", async () => {
      result = await handler(event, context);

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idx: 3,
          uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
        }),
      });

      const sqsMessageBody =
        mockSQSClient.commandCalls(SendMessageCommand)[0].args[0].input
          .MessageBody;
      expect(mockSQSClient.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(sqsMessageBody).toContain("CRS_INDEX_ISSUED");
      expect(sqsMessageBody).toContain(PUBLIC_KEY);
      expect(sqsMessageBody).toContain(GOLDEN_JWT);
      expect(sqsMessageBody).toContain(
        '"index":3,"uri":"https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD"',
      );
      expect(sqsMessageBody).toContain(
        '"keyId":"cc2c3738-03ec-4214-a65e-7f0461a34e7b"',
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
      ],
      [
        buildRequest({ body: JWT_WITH_NO_KID }),
        "No Kid in Header",
        JWT_WITH_NO_KID,
        "null",
      ],
      [
        buildRequest({ body: JWT_WITH_NO_ISS }),
        "No Issuer in Payload",
        JWT_WITH_NO_ISS,
        TEST_KID,
      ],
    ])(
      "Returns 400 with correct descriptions",
      async (event, errorDescription, request, kid) => {
        result = await handler(event, context);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 400,
          body: JSON.stringify({
            error: "BAD_REQUEST",
            error_description: errorDescription,
          }),
        });
        assertAndValidateErrorAuditSQSMessage(
          "CRS_ISSUANCE_FAILED",
          PUBLIC_KEY,
          kid,
          request,
          "400",
          "BAD_REQUEST",
        );
      },
    );
  });

  describe("Unauthorized Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: JWT_WITH_NON_MATCHING_CLIENT_ID }),
        "No matching client found with ID: DAkekdNSkekSNljrwevOIUPenGeS",
        JWT_WITH_NON_MATCHING_CLIENT_ID,
      ],
      [
        buildRequest({ body: JWT_WITH_NON_MATCHING_KID }),
        "No matching Key ID found in JWKS Endpoint for Kid: 1fb2c0f07f643b45cafeb53fb9d9eb34",
        JWT_WITH_NON_MATCHING_KID,
      ],
    ])(
      "Returns 401 with correct descriptions",
      async (event, errorDescription, request: string) => {
        result = await handler(event, context);

        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 401,
          body: JSON.stringify({
            error: "UNAUTHORISED",
            error_description: errorDescription,
          }),
        });
        assertAndValidateErrorAuditSQSMessage(
          "CRS_ISSUANCE_FAILED",
          PUBLIC_KEY,
          "1fb2c0f07f643b45cafeb53fb9d9eb34",
          request,
          "401",
          "UNAUTHORISED",
        );
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
      assertAndValidateErrorAuditSQSMessage(
        "CRS_ISSUANCE_FAILED",
        PUBLIC_KEY,
        TEST_KID,
        JWT_WITH_NO_JWKS_URI,
        "500",
        "INTERNAL_SERVER_ERROR",
      );
    });
  });
});

function assertAndValidateErrorAuditSQSMessage(
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
  expect(sqsMessageBody).toContain(eventName);
  expect(sqsMessageBody).toContain(signingKey);
  expect(sqsMessageBody).toContain(kid);
  expect(sqsMessageBody).toContain(jwtRequest);
  expect(sqsMessageBody).toContain(statusCode);
  expect(sqsMessageBody).toContain(error);
}
