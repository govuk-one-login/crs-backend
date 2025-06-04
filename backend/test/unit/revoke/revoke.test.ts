import {GetObjectCommand, S3Client} from "@aws-sdk/client-s3";

process.env.STATUS_LIST_TABLE = "StatusListTable";
import {handler} from "../../../src/functions/revokeHandler";
import {logger} from "../../../src/common/logging/logger";
import {LogMessage} from "../../../src/common/logging/LogMessages";
import {APIGatewayProxyEvent} from "aws-lambda";
import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {mockClient} from "aws-sdk-client-mock";
import {buildLambdaContext} from "../../utils/mockContext";
import {buildRequest} from "../../utils/mockRequest";
import {describe} from "@jest/globals";
import {
    ALREADY_REVOKED_JWT,
    PUBLIC_KEY,
    REVOKE_GOLDEN_JWT,
    REVOKE_GOLDEN_TOKEN_JWT,
    REVOKE_JWT_WITH_INVALID_LIST_TYPE,
    REVOKE_JWT_WITH_INVALID_URI,
    REVOKE_JWT_WITH_NO_CLIENT_ID,
    REVOKE_JWT_WITH_NO_INDEX, REVOKE_JWT_WITH_NO_JWKS_URI,
    REVOKE_JWT_WITH_NO_KID,
    REVOKE_JWT_WITH_NO_URI, REVOKE_JWT_WITH_NON_MATCHING_CLIENT_ID, REVOKE_JWT_WITH_NON_MATCHING_KID,
    REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE,
    TEST_CLIENT_ID,
    TEST_KID, TEST_NON_MATCHING_KID
} from "../../utils/testConstants";
import {importSPKI} from "jose";
import * as jose from "jose";
import {sdkStreamMixin} from "@smithy/util-stream-node";
import {Readable} from "stream";

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

const mockS3Client = mockClient(S3Client);
const mockDBClient = mockClient(DynamoDBClient);

describe("Testing Revoke Lambda", () => {
    const mockEvent = buildRequest({body: REVOKE_GOLDEN_JWT});
    const mockContext = buildLambdaContext();

    beforeEach(() => {
        jest.clearAllMocks();
        mockDBClient.reset();
        mockS3Client.reset();

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

        mockDBClient.on(GetItemCommand).resolves({
            Item: {
                uri: {S: "B2757C3F6091"},
                idx: {N: "1680"},
                clientId: {S: "DNkekdNSkekSNljrwevOIUPenGeS"},
                issuedAt: {N: String(Date.now())},
                listType: {S: "BitstringStatusList"},
            },
        });

        jest.spyOn(jose, "importJWK").mockResolvedValue(importedPublicKey);
    });

    const createTestEvent = (payload: object): APIGatewayProxyEvent => ({
        ...buildRequest({body: JSON.stringify(payload)}),
    });

    describe("successful revocation scenarios", () => {
        it("should return 200 revoke success with BitStringStatusList", async () => {

            mockDBClient.on(UpdateItemCommand).resolves({});

            const response = await handler(mockEvent, mockContext);

            // Parse response body to extract timestamp
            const responseBody = JSON.parse(response.body);

            expect(response).toStrictEqual({
                statusCode: 200,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    message: "Request processed for revocation",
                    revokedAt: responseBody.revokedAt,
                }),
            });

            // Additional validation for timestamp format
            expect(responseBody.revokedAt).toMatch(/^\d+$/);
            expect(parseInt(responseBody.revokedAt)).toBeGreaterThan(0);

            expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
            expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(1);
        });

        it("should return 200 revoke success with TokenStatusList", async () => {

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    clientId: {S: "DNkekdNSkekSNljrwevOIUPenGeS"},
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "456"},
                    listType: {S: "TokenStatusList"},
                },
            });
            mockDBClient.on(UpdateItemCommand).resolves({});

            const event = buildRequest({body: REVOKE_GOLDEN_TOKEN_JWT});
            const response = await handler(event, mockContext);
            const responseBody = JSON.parse(response.body);

            expect(response).toStrictEqual({
                statusCode: 200,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    message: "Request processed for revocation",
                    revokedAt: responseBody.revokedAt,
                }),
            });

            // Additional validation for timestamp format
            expect(responseBody.revokedAt).toMatch(/^\d+$/);
            expect(parseInt(responseBody.revokedAt)).toBeGreaterThan(0);
        });

        it("should return 202 OK for already revoked credential", async () => {

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    clientId: {S: "DNkekdNSkekSNljrwevOIUPenGeS"},
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "123"},
                    listType: {S: "TokenStatusList"},
                    revokedAt: {N: "1640995200"},
                },
            });

            const event = buildRequest({body: ALREADY_REVOKED_JWT});
            const response = await handler(event, mockContext);

            expect(response).toStrictEqual({
                statusCode: 202,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    message: "Credential already revoked",
                    revokedAt: "1640995200",
                }),
            });

            expect(mockDBClient.commandCalls(GetItemCommand)).toHaveLength(1);
            expect(mockDBClient.commandCalls(UpdateItemCommand)).toHaveLength(0);
        });
    });

    describe("Bad Request Error Scenarios", () => {
        test.each([
            [
                buildRequest({body: REVOKE_JWT_WITH_NO_KID}),
                "No Kid in Header",
                REVOKE_JWT_WITH_NO_KID,
                "null",
                TEST_CLIENT_ID,
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_NO_INDEX}),
                "No Index in Payload",
                REVOKE_JWT_WITH_NO_INDEX,
                TEST_KID,
                TEST_CLIENT_ID,
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_NO_URI}),
                "No URI in Payload",
                REVOKE_JWT_WITH_NO_URI,
                TEST_KID,
                "",
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_NO_CLIENT_ID}),
                "No Issuer in Payload",
                REVOKE_JWT_WITH_NO_CLIENT_ID,
                TEST_KID,
                "",
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_INVALID_URI}),
                "Invalid URI format",
                REVOKE_JWT_WITH_INVALID_URI,
                TEST_KID,
                "",
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_INVALID_LIST_TYPE}),
                "Invalid list type in URI: must be /t/ or /b/",
                REVOKE_JWT_WITH_INVALID_LIST_TYPE,
                TEST_KID,
                "",
            ],
        ])(
            "Returns 400 with correct descriptions",
            async (event, errorDescription) => {
                const result = await handler(event, mockContext);

                expect(result).toStrictEqual({
                    headers: {"Content-Type": "application/json"},
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "BAD_REQUEST",
                        error_description: errorDescription,
                    }),
                });
            },
        );

        it("Returns 400 on a empty request body", async () => {
            const result = await handler(buildRequest({body: null}), mockContext);

            expect(result).toStrictEqual({
                headers: {"Content-Type": "application/json"},
                statusCode: 400,
                body: JSON.stringify({
                    error: "BAD_REQUEST",
                    error_description: "No Request Body Found",
                }),
            });
        });
    });

    describe("Unauthorized Request Error Scenarios", () => {
        test.each([
            [
                buildRequest({body: REVOKE_JWT_WITH_NON_MATCHING_CLIENT_ID}),
                "No matching client found with ID: asvvnsjeEJEWjjwSHsIksIksIhBe ",
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_NON_MATCHING_KID}),
                `No matching Key ID found in JWKS Endpoint for Kid: ${TEST_NON_MATCHING_KID}`,
            ],
            [
                buildRequest({body: REVOKE_JWT_WITH_NON_VERIFIED_SIGNATURE}),
                "Failure verifying the signature of the jwt",
            ],
        ])(
            "Returns 401 with correct descriptions",
            async (event, errorDescription) => {
                const result = await handler(event, mockContext);

                expect(result).toStrictEqual({
                    headers: {"Content-Type": "application/json"},
                    statusCode: 401,
                    body: JSON.stringify({
                        error: "UNAUTHORISED",
                        error_description: errorDescription,
                    }),
                });
            },
        );

        it("Returns 401 error when credential to revoke has different clientId than request", async () => {
            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    uri: {S: "B2757C3F6091"},
                    idx: {N: "1680"},
                    clientId: {S: "NONEXISTANT"},
                    issuedAt: {N: String(Date.now())},
                    listType: {S: "BitstringStatusList"},
                },
            });

            const event = buildRequest({body: REVOKE_GOLDEN_JWT});
            const result = await handler(event, mockContext);

            expect(result).toStrictEqual({
                headers: {"Content-Type": "application/json"},
                statusCode: 401,
                body: JSON.stringify({
                    error: "UNAUTHORISED",
                    error_description:
                        "The original clientId is different to the clientId in the request",
                }),
            });
        });
    });

    describe("Not Found Error Scenarios", () => {

        it("should return 404 if entry does not exist in database", async () => {

            mockDBClient.on(GetItemCommand).resolves({Item: undefined});

            const response = await handler(mockEvent, mockContext);

            expect(response).toStrictEqual({
                statusCode: 404,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    error: "NOT_FOUND",
                    error_description: "Entry not found in status list table",
                }),
            });
        });

        it("should return 404 for list type mismatch", async () => {

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "123"},
                    listType: {S: "TokenStatusList"},
                },
            });

            const result = await handler(mockEvent, mockContext);

            expect(result).toStrictEqual({
                statusCode: 404,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    error: "NOT_FOUND",
                    error_description:
                        "List type mismatch: Expected BitstringStatusList but entry has TokenStatusList",
                }),
            });
        });

        it("should return 404 for entry with undefined list type", async () => {

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "123"},
                },
            });

            const response = await handler(mockEvent, mockContext);

            expect(response).toStrictEqual({
                statusCode: 404,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    error: "NOT_FOUND",
                    error_description:
                        "List type mismatch: Expected BitstringStatusList but entry has undefined",
                }),
            });
        });

        it("should return 400 if DynamoDB query fails", async () => {


            mockDBClient
                .on(GetItemCommand)
                .rejects(new Error("DynamoDB connection error"));

            const response = await handler(mockEvent, mockContext);

            expect(response).toStrictEqual({
                statusCode: 500,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    error: "INTERNAL_SERVER_ERROR",
                    error_description: "Error querying database: Error: DynamoDB connection error",
                }),
            });
        });


        it("should return 400 if DynamoDB update fails", async () => {

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    clientId: {S: TEST_CLIENT_ID},
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "123"},
                    listType: {S: "TokenStatusList"},
                },
            });
            mockDBClient
                .on(UpdateItemCommand)
                .rejects(new Error("Update operation failed"));

            const response = await handler(buildRequest({body: REVOKE_GOLDEN_TOKEN_JWT}), mockContext);

            expect(response).toStrictEqual({
                statusCode: 500,
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    error: "INTERNAL_SERVER_ERROR",
                    error_description: "Error processing revocation request",
                }),
            });
        });

        describe("logging functionality", () => {
            it("should setup logger correctly", async () => {
                await handler(mockEvent, mockContext);

                expect(logger.resetKeys).toHaveBeenCalledTimes(1);
                expect(logger.addContext).toHaveBeenCalledWith(mockContext);
                expect(logger.appendKeys).toHaveBeenCalledWith({
                    functionVersion: mockContext.functionVersion,
                });
            });

            it("should log the handler being called", async () => {
                const response = await handler(mockEvent, mockContext);
                const responseBody = JSON.parse(response.body);

                expect(response).toStrictEqual({
                    statusCode: 200,
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        message: "Request processed for revocation",
                        revokedAt: responseBody.revokedAt,
                    }),
                });
                expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_LAMBDA_CALLED);
            });
        });

        it("should log the handler being called", async () => {
            const payload = {
                iss: "client1",
                idx: 123,
                uri: "https://dummy-uri/t/3B0F3BD087A7",
            };

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "123"},
                    listType: {S: "TokenStatusList"},
                },
            });
            mockDBClient.on(UpdateItemCommand).resolves({});

            const event = createTestEvent(payload);
            await handler(event, mockContext);

            expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_LAMBDA_CALLED);
        });

        it("should log successful operations appropriately", async () => {

            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    clientId: {S: TEST_CLIENT_ID},
                    uri: {S: "3B0F3BD087A7"},
                    idx: {N: "123"},
                    listType: {S: "BitstringStatusList"},
                },
            });
            mockDBClient.on(UpdateItemCommand).resolves({});

            await handler(mockEvent, mockContext);

            expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_LAMBDA_CALLED)
            expect(logger.info).toHaveBeenCalledWith("Succesfully decoded JWT as JSON");
            expect(logger.info).toHaveBeenCalledWith("Updating revokedAt field in DynamoDB");
            expect(logger.info).toHaveBeenCalledTimes(8);
        });
    });

    describe("Internal Server Error Scenarios", () => {
        it("Returns 500 error when no JWKSUri found on matchingClient in registry", async () => {
            const event = buildRequest({ body: REVOKE_JWT_WITH_NO_JWKS_URI });
            const result = await handler(event, mockContext);

            expect(logger.info).toHaveBeenCalledWith(LogMessage.REVOKE_LAMBDA_CALLED);
            expect(result).toStrictEqual({
                headers: { "Content-Type": "application/json" },
                statusCode: 500,
                body: JSON.stringify({
                    error: "INTERNAL_SERVER_ERROR",
                    error_description: "No jwksUri found on client ID: mockClientId",
                }),
            });
        });

        it("Returns 500 error when no clientId exists on credential", async () => {
            mockDBClient.on(GetItemCommand).resolves({
                Item: {
                    uri: { S: "B2757C3F6091" },
                    idx: { N: "1680" },
                    issuedAt: { N: String(Date.now()) },
                    listType: { S: "BitstringStatusList" },
                },
            });

            const event = buildRequest({ body: REVOKE_GOLDEN_JWT });
            const result = await handler(event, mockContext);

            expect(result).toStrictEqual({
                headers: { "Content-Type": "application/json" },
                statusCode: 500,
                body: JSON.stringify({
                    error: "INTERNAL_SERVER_ERROR",
                    error_description:
                        "No client ID found on item index: 1680 and uri: B2757C3F6091",
                }),
            });
        });
    });
})



