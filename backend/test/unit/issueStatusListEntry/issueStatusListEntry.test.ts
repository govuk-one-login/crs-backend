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
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream-node";

const mockS3Client = mockClient(S3Client);
const JWT_WITH_NO_EXPIRES =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwIjoiSm9oIERvZSJ9.X67yrAKMLBz5CUR7_CLmHqiyktDRjcs7C9giMemFnrli1Temo4eMh5Z8-HHPmg-C0ACmQM0lVoUyD8esQLPhew";
const JWT_WITH_NO_KID =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.RoM7Z-Ir0yKPTSqEyN0pbThdmEHL-cwxMUb_lZw-ZgSdRSbfWQBLdCg6L0lT_GG-o7_LEyFitmiX-Ya_jKe20g";
const JWT_WITH_NO_ISS =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHBpcmVzIjoiMTczNDcwOTQ5MyJ9.B_UdkdQJau-klyipvFHAJszalSf3a8IW5wUfk8lNtV7jIQxx-Px7TpUvl2FES51pKnGSSeLZA_v-TxldLrBRWg";
const JWT_WITH_NON_MATCHING_CLIENT_ID =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjFmYjJjMGYwN2Y2NDNiNDVjYWZlYjUzZmI5ZDllYjM0In0.eyJpc3MiOiJEQWtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.XSos0P9wZYV_QEzKe6UFpVrn-D2_1oK6emDyrix_cXGSg5gS1cu2l7rImGDZ_DOgZlqsNzj1KbQbjvRFFSAhjw";
const JWT_WITH_NON_MATCHING_KID =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjFmYjJjMGYwN2Y2NDNiNDVjYWZlYjUzZmI5ZDllYjM0In0.eyJpc3MiOiJETmtla2ROU2tla1NObGpyd2V2T0lVUGVuR2VTIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.BLL1kOTPZFI8gfYZZghPO65oipEnRBVefAqobZ3RmI9E14vB-l9taEAdgVKKyBVQe6XIRSuhsXC6Nv5UDBt57A";
const JWT_WITH_NO_JWKS_URI =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjFmYjJjMGYwN2Y2NDNiNDVjYWZlYjUzZmI5ZDllYjM0In0.eyJpc3MiOiJtb2NrQ2xpZW50SWQiLCJleHBpcmVzIjoiMTczNDcwOTQ5MyJ9.ke-nv-29hl6TAgDThDkFd-QCHptfHSDnG0j7R2b3zBl2bQCqai47jjPnUW4O97Dlao4z_SqMDGOHtNZWedpfVQ";

describe("Testing IssueStatusListEntry Lambda", () => {
  let consoleInfoSpy: jest.SpyInstance;
  let result: APIGatewayProxyResult;
  let context: Context;
  let event: APIGatewayProxyEvent;

  beforeEach(() => {
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
    it("Returns 200 and the session details", async () => {
      result = await handler(event, context);

      expect(result).toStrictEqual({
        headers: { "Content-Type": "application/json" },
        statusCode: 200,
        body: JSON.stringify({
          idx: 3,
          uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
        }),
      });
    });
  });

  describe("Bad Request Error Scenarios", () => {
    test.each([
      [buildRequest({ body: null }), "No Request Body Found"],
      [
        buildRequest({ body: JWT_WITH_NO_EXPIRES }),
        "No Expiry Date in Payload",
      ],
      [buildRequest({ body: JWT_WITH_NO_KID }), "No Kid in Header"],
      [buildRequest({ body: JWT_WITH_NO_ISS }), "No Issuer in Payload"],
    ])(
      "Returns 400 with correct descriptions",
      async (event, errorDescription) => {
        result = await handler(event, context);

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
  });

  describe("Unauthorized Request Error Scenarios", () => {
    test.each([
      [
        buildRequest({ body: JWT_WITH_NON_MATCHING_CLIENT_ID }),
        "No matching client found with ID: DAkekdNSkekSNljrwevOIUPenGeS",
      ],
      [
        buildRequest({ body: JWT_WITH_NON_MATCHING_KID }),
        "No matching Key ID found in JWKS Endpoint for Kid: 1fb2c0f07f643b45cafeb53fb9d9eb34",
      ],
    ])(
      "Returns 401 with correct descriptions",
      async (event, errorDescription) => {
        result = await handler(event, context);

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
    });
  });
});
