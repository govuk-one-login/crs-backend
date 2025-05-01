import { handler } from "../../../src/functions/issueStatusListEntryHandler";
import {APIGatewayProxyResult, APIGatewayProxyEvent, Context } from 'aws-lambda';
import { describe, expect } from "@jest/globals";
import { buildRequest } from "../../utils/mockRequest";
import { buildLambdaContext } from "../../utils/mockContext";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import "../../utils/matchers";

describe("testing handler setup correctly", () => {
  //let context: Context;
  let consoleInfoSpy: jest.SpyInstance;
  let result: APIGatewayProxyResult;
  const validRequest = buildRequest();
  const context = buildLambdaContext();

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, "info");
  });
  describe("On every invocation", () => {

    beforeEach(async () => {
      result = await handler(validRequest, context);
    });

      it("Adds context and version to log attributes and logs STARTED message", async () => {
        expect(consoleInfoSpy).toHaveBeenCalledWithLogFields({
          messageCode: "ISSUE_LAMBDA_STARTED",
        })
      });

      it("Returns 200 and the session details", () => {
        expect(result).toStrictEqual({
          headers: { "Content-Type": "application/json" },
          statusCode: 200,
          body: JSON.stringify({
            'idx': 3,
            'uri': "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD" }),
        });
      });
    });
  }
);

