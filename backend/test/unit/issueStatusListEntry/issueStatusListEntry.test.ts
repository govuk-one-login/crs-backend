import { handler } from "../../../src/functions/issueStatusListEntryHandler";
import { APIGatewayProxyResult, Context } from "aws-lambda";
import { describe, expect } from "@jest/globals";
import { buildRequest } from "../../utils/mockRequest";
import { buildLambdaContext } from "../../utils/mockContext";
import "../../utils/matchers";
import { logger } from "../../../src/common/logging/logger";

describe("testing handler setup correctly", () => {
  let consoleInfoSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let result: APIGatewayProxyResult;
  let context: Context;

  const validRequest = buildRequest();

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, "info");
    consoleErrorSpy = jest.spyOn(console, "error");
    context = buildLambdaContext();
  });

  describe("On every invocation", () => {
    beforeEach(async () => {
      result = await handler(validRequest, context);
    });

    it("logs STARTED message", async () => {
      expect(consoleInfoSpy).toHaveBeenCalledWithLogFields({
        messageCode: "ISSUE_LAMBDA_STARTED",
      });
    });

    it("doesnt log Error Messages", async () => {
      expect(consoleInfoSpy).toHaveBeenCalledWithLogFields({});
    });

    it("Clears pre-existing log attributes", async () => {
      logger.appendKeys({ testKey: "testValue" });
      result = await handler(validRequest, context);

      expect(consoleInfoSpy).not.toHaveBeenCalledWithLogFields({
        testKey: "testValue",
      });
    });

    it("Returns 200 and the session details", () => {
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
});
