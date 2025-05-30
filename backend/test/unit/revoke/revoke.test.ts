import { handler } from "../../../src/functions/revokeHandler";
import { logger } from "../../../src/common/logging/logger";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import { Context, APIGatewayProxyEvent } from "aws-lambda";

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

describe("revoke handler", () => {
  const mockEvent = {} as APIGatewayProxyEvent;
  const mockContext = {
    functionVersion: "v1.0",
    awsRequestId: "test-request-id",
  } as Context;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 202 Accepted status code", async () => {
    const response = await handler(mockEvent, mockContext);

    expect(response.statusCode).toBe(202);
  });

  it("should return correct message in response body", async () => {
    const response = await handler(mockEvent, mockContext);
    const body = JSON.parse(response.body);

    expect(body).toEqual({ message: "Request accepted for revocation" });
  });

  it("should return correct Content-Type header", async () => {
    const response = await handler(mockEvent, mockContext);

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

    expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_HANDLER_CALLED);
  });
});
