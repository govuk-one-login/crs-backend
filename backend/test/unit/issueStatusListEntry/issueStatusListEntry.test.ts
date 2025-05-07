import { handler } from "../../../src/functions/issueStatusListEntryHandler";
import { APIGatewayProxyResult, Context } from "aws-lambda";
import { describe, expect } from "@jest/globals";
import { buildLambdaContext } from "../../utils/mockContext";
import "../../utils/matchers";
import { logger } from "../../../src/common/logging/logger";

describe("testing handler setup correctly", () => {
  let consoleInfoSpy: jest.SpyInstance;
  let result: APIGatewayProxyResult;
  let context: Context;

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, "info");
    context = buildLambdaContext();
  });

  describe("On every invocation", () => {
    beforeEach(async () => {
      result = await handler(context);
    });

    it("logs STARTED message", async () => {
      expect(consoleInfoSpy).toHaveBeenCalledWithLogFields({
        messageCode: "ISSUE_LAMBDA_STARTED",
      });
    });

    it("Clears pre-existing log attributes", async () => {
      logger.appendKeys({ testKey: "testValue" });
      result = await handler(context);

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
