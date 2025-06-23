import { handler } from "../../../src/functions/statusListPublisherHandler";
import { describe, test, expect } from "@jest/globals";
import { buildLambdaContext } from "../../utils/mockContext";
import { logger } from "../../../src/common/logging/logger";
import { LogMessage } from "../../../src/common/logging/LogMessages";

describe("Testing Status List Publisher Lambda", () => {
  const mockContext = buildLambdaContext();
  let loggerInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    loggerInfoSpy = jest.spyOn(logger, "info");
  });

  describe("On every invocation", () => {
    it("logs STARTED message and COMPLETED message", async () => {
      handler(mockContext);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_COMPLETED,
      );
    });
  });

  test("handler should return appropriate response", () => {
    expect(handler(mockContext)).toBeInstanceOf(Response);
    expect(handler(mockContext).status).toBe(501);
    expect(handler(mockContext).statusText).toBe("Not Implemented");
  });
});