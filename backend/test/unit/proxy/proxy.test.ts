import {LogMessage} from "../../../src/common/logging/LogMessages";

process.env.BITSTRING_QUEUE_URL = "BitstringStatusList";
process.env.TOKEN_STATUS_QUEUE_URL = "TokenStatusList";

import {handler} from "../../../src/functions/proxyHandler";
import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
    Context,
} from "aws-lambda";
import {describe, expect} from "@jest/globals";
import {buildLambdaContext} from "../../utils/mockContext";
import "../../utils/matchers";
import {logger} from "../../../src/common/logging/logger";
import {buildProxyRequest} from "../../utils/mockProxyRequest";
import axios from "axios";

describe("Testing Proxy Lambda", () => {
    let result: APIGatewayProxyResult;
    let context: Context;
    let event: APIGatewayProxyEvent;
    let loggerInfoSpy: jest.SpyInstance;
    let loggerErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        loggerInfoSpy = jest.spyOn(logger, "info");
        loggerErrorSpy = jest.spyOn(logger, "error");

        context = buildLambdaContext();
        event = buildProxyRequest();

        jest.spyOn(axios, "post").mockResolvedValue({
            status: 200,
            data: {success: true},
            headers: {"x-custom-header": "value"},
        });
    });

    describe("Happy Paths", () => {
        it("logs STARTED message and COMPLETED message, and has correct result", async () => {
            result = await handler(event, context);
            expect(loggerInfoSpy).toHaveBeenCalledWith(
                LogMessage.PROXY_LAMBDA_STARTED,
            );
            expect(loggerInfoSpy).toHaveBeenCalledWith(
                LogMessage.PROXY_LAMBDA_COMPLETED,
            );

            expect(result).toEqual({
                statusCode: 200,
                body: JSON.stringify({success: true}),
                headers: {"x-custom-header": "value"},
            });
        });
    });

    describe("Error Paths", () => {
        describe("Invalid path", () => {
            it("returns a error", async () => {
                await handler(buildProxyRequest({path: "/invalidPath"}), context);
                expect(loggerInfoSpy).toHaveBeenCalledWith(
                    LogMessage.PROXY_LAMBDA_STARTED,
                );
                expect(loggerErrorSpy).toHaveBeenCalledWith(LogMessage.PROXY_UNEXPECTED_PATH, {
                    errorMessage: `Path is not one of the permitted values: /invalidPath`,
                });
            });
        });
        describe("Invalid HTTP method", () => {
            it("returns a error", async () => {
                await handler(buildProxyRequest({httpMethod: "GET"}), context);
                expect(loggerInfoSpy).toHaveBeenCalledWith(
                    LogMessage.PROXY_LAMBDA_STARTED,
                );
                expect(loggerErrorSpy).toHaveBeenCalledWith(LogMessage.PROXY_UNEXPECTED_HTTP_METHOD, {
                    errorMessage: "GET request is unexpected, only POST is allowed.",
                });
            });
        })
        describe("Error in proxy handler", () => {
            it("returns a internal server response", async () => {
                jest.spyOn(axios, "post").mockRejectedValue(new Error("Network error"));
                result = await handler(buildProxyRequest(), context);
                expect(loggerInfoSpy).toHaveBeenCalledWith(
                    LogMessage.PROXY_LAMBDA_STARTED,
                );
                expect(loggerErrorSpy).toHaveBeenCalledWith(LogMessage.PROXY_REQUEST_ERROR, {
                    errorMessage: "Error sending network request: Error: Network error",
                });
                expect(result).toEqual({
                    statusCode: 500,
                    body: JSON.stringify({
                        error: "INTERNAL_SERVER_ERROR",
                        error_description: "An error occurred while processing the request.",
                    }),
                    headers: {"Content-Type": "application/json"},
                });
            });
        });
    });
});