import { mockClient } from "aws-sdk-client-mock";

process.env.STATUS_LIST_TABLE = "StatusListTable";
import {
  generateBitStringJWT,
  generateTokenByteArray,
  generateTokenStatusJWT,
  handler,
} from "../../../src/functions/statusListPublisherHandler";
import { logger } from "../../../src/common/logging/logger";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import { buildLambdaContext } from "../../utils/mockContext";
import { describe, expect } from "@jest/globals";
import {
  AttributeValue,
  DynamoDBClient,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  generateByteArray,
  getUriItems,
} from "../../../src/functions/statusListPublisherHandler";
import {
  PUBLISHING_GOLDEN_BITSTRING_JWT_LOCAL,
  PUBLISHING_GOLDEN_BITSTRING_JWT_PIPELINE,
  PUBLISHING_GOLDEN_TOKEN_JWT,
  TEST_CLIENT_ID_BITSTRING,
} from "../../utils/testConstants";
import { S3Client } from "@aws-sdk/client-s3";
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  SignCommandInput,
} from "@aws-sdk/client-kms";
import { exportPKCS8, exportSPKI, generateKeyPair, KeyLike } from "jose";
import crypto from "crypto";
import {
  createMultipleRecordSQSEvent,
  createSQSEvent,
} from "../../utils/mockSQSEvent";
import { APIGatewayProxyResult } from "aws-lambda";

let validKmsPublicKeyDer: Uint8Array;

const mockDBClient = mockClient(DynamoDBClient);
const mockS3Client = mockClient(S3Client);
const mockKMSClient = mockClient(KMSClient); // Assuming KMS is also mocked similarly
const context = buildLambdaContext();
let mockSQSEvent;

const EXPECTED_ERROR_RESPONSE = {
  error: "INTERNAL_SERVER_ERROR",
  error_description: "Failed to generate a signed JWT",
};

const expectErrorResponse = (
  result: APIGatewayProxyResult,
  expectedResponse = EXPECTED_ERROR_RESPONSE,
) => {
  expect(result.statusCode).toBe(500);
  expect(JSON.parse(result.body)).toEqual(expectedResponse);
};

const setupValidKmsResponse = () => {
  mockKMSClient.on(GetPublicKeyCommand).resolves({
    PublicKey: validKmsPublicKeyDer,
    KeyUsage: "SIGN_VERIFY",
    KeySpec: "ECC_NIST_P256",
  });
};

describe("Testing Status List Publisher Lambda", () => {
  let loggerInfoSpy: jest.SpyInstance;
  let loggerErrorSpy: jest.SpyInstance;
  let keyPair;
  let spkiPem;

  const setupKmsSignWithKey = async (privateKey: KeyLike) => {
    const pkcs8Pem = await exportPKCS8(privateKey);
    mockKMSClient.on(SignCommand).callsFake(async (input: SignCommandInput) => {
      if (!input.Message)
        throw new Error("SignCommand mock called without Message");

      const messageToSign = Buffer.from(input.Message);
      const signer = crypto.createSign("SHA256");
      signer.update(messageToSign);
      const derSignatureBuffer = signer.sign({
        key: pkcs8Pem,
        dsaEncoding: "der",
        format: "pem",
      });

      return {
        Signature: new Uint8Array(derSignatureBuffer),
        SigningAlgorithm: input.SigningAlgorithm || "ECDSA_SHA_256",
        KeyId: input.KeyId || process.env.KMS_SIGNING_KEY_ARN,
      };
    });
  };
  beforeAll(async () => {
    keyPair = await generateKeyPair("ES256");
    spkiPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(async () => {
    loggerInfoSpy = jest.spyOn(logger, "info");
    loggerErrorSpy = jest.spyOn(logger, "error");
    mockDBClient.reset();
    mockS3Client.reset();
    mockKMSClient.reset();
    mockSQSEvent = createSQSEvent("B2757C3F6091");

    mockDBClient.on(QueryCommand).resolves({
      Items: [
        {
          uri: { S: "B2757C3F6091" },
          idx: { N: "2" },
          clientId: { S: TEST_CLIENT_ID_BITSTRING },
          issuedAt: { N: String(Date.now()) },
          listType: { S: "BitstringStatusList" },
          revokedAt: { N: String(Date.now()) },
        },
      ],
    });

    validKmsPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);

    mockKMSClient.on(GetPublicKeyCommand).resolves({
      PublicKey: validKmsPublicKeyDer,
      KeyUsage: "SIGN_VERIFY",
      KeySpec: "ECC_NIST_P256",
    });

    setupKmsSignWithKey(keyPair.privateKey);
  });

  describe("Happy Path Scenarios", () => {
    it("should return 200 success with correct bitstring byteArray and index 2 revoked", async () => {
      const result = await handler(mockSQSEvent, context);

      const mockUriItems = <Record<string, AttributeValue>[]>(
        await getUriItems("B2757C3F6091")
      );
      const testByteArray = generateByteArray(mockUriItems);

      expect(get2BitValue(testByteArray, 1)).toBe(0b00); // First item is not revoked
      expect(get2BitValue(testByteArray, 2)).toBe(0b01); // Second item is revoked

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"message":"SQS Event processed successfully"}',
      });

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_STARTED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_COMPLETED,
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        `JWT successfully published to S3 for groupId: B2757C3F6091, groupType: BitstringStatusList`,
      );

      assertKMSValidation(loggerInfoSpy);
    });
    it("should return 200 success with correct token status byteArray and index 3 revoked", async () => {
      mockSQSEvent = createSQSEvent("T2757C3F6091");

      mockDBClient.on(QueryCommand).resolves({
        Items: [
          {
            uri: { S: "T2757C3F6091" },
            idx: { N: "3" },
            clientId: { S: TEST_CLIENT_ID_BITSTRING },
            issuedAt: { N: String(Date.now()) },
            listType: { S: "TokenStatusList" },
            revokedAt: { N: String(Date.now()) },
          },
        ],
      });

      const result = await handler(mockSQSEvent, context);

      const mockUriItems = <Record<string, AttributeValue>[]>(
        await getUriItems("T2757C3F6091")
      );
      const testByteArray = generateTokenByteArray(mockUriItems);

      expect(get2BitValueTokenList(testByteArray, 1)).toBe(0b00); // First item is not revoked
      expect(get2BitValueTokenList(testByteArray, 2)).toBe(0b00); // Second item is not revoked
      expect(get2BitValueTokenList(testByteArray, 3)).toBe(0b01); // Third item is revoked
      expect(testByteArray.byteLength).toBe(25000); // Ensure byte array length is 25000 bytes

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"message":"SQS Event processed successfully"}',
      });

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        `JWT successfully published to S3 for groupId: T2757C3F6091, groupType: TokenStatusList`,
      );

      assertKMSValidation(loggerInfoSpy);
    });
    it("should return correct byte arrays when there are multiple records with different revoked values and types", async () => {
      mockSQSEvent = createMultipleRecordSQSEvent(
        "B2757C3F6091",
        "T2757C3F6091",
      );

      mockDBClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [
            {
              uri: { S: "B2757C3F6091" },
              idx: { N: "2" },
              clientId: { S: TEST_CLIENT_ID_BITSTRING },
              issuedAt: { N: String(Date.now()) },
              listType: { S: "BitStringStatusList" },
              revokedAt: { N: String(Date.now()) },
            },
          ],
        })
        .resolves({
          Items: [
            {
              uri: { S: "T2757C3F6091" },
              idx: { N: "3" },
              clientId: { S: TEST_CLIENT_ID_BITSTRING },
              issuedAt: { N: String(Date.now()) },
              listType: { S: "TokenStatusList" },
              revokedAt: { N: String(Date.now()) },
            },
          ],
        });

      const mockBitStringUriItems = <Record<string, AttributeValue>[]>(
        await getUriItems("B2757C3F6091")
      );
      const mockTokenListUriItems = <Record<string, AttributeValue>[]>(
        await getUriItems("T2757C3F6091")
      );
      const testBitStringByteArray = generateByteArray(mockBitStringUriItems);
      const testTokenListByteArray = generateTokenByteArray(
        mockTokenListUriItems,
      );

      expect(get2BitValue(testBitStringByteArray, 1)).toBe(0b00); // First item is not revoked
      expect(get2BitValue(testBitStringByteArray, 2)).toBe(0b01); // Second item is not revoked
      expect(get2BitValue(testBitStringByteArray, 3)).toBe(0b00); // Third item is revoked
      expect(testBitStringByteArray.byteLength).toBe(25000); // Ensure byte array length is 25000 bytes

      expect(get2BitValueTokenList(testTokenListByteArray, 2)).toBe(0b00); // Second item is not revoked
      expect(get2BitValueTokenList(testTokenListByteArray, 3)).toBe(0b01); // Third item is revoked
      expect(testTokenListByteArray.byteLength).toBe(25000); // Ensure byte array length is 25000 bytes
    });

    it("should create the correct JWT for the BitstringStatusList", async () => {
      const mockDate = new Date("2200-02-14T00:00:00Z");
      jest.spyOn(global, "Date").mockImplementation(() => mockDate);

      const mockUriItems = <Record<string, AttributeValue>[]>(
        await getUriItems("B2757C3F6091")
      );
      const testJWT = await generateBitStringJWT(
        mockUriItems,
        "B2757C3F6091",
        "BitstringStatusList",
      );

      expect(testJWT.split(".")).toHaveLength(3);

      const payload = testJWT.split(".")[1];

      //We cant verify a exact payload as the gzip compression output unreliable if ran locally vs pipeline
      expect([
        PUBLISHING_GOLDEN_BITSTRING_JWT_LOCAL.split(".")[1],
        PUBLISHING_GOLDEN_BITSTRING_JWT_PIPELINE.split(".")[1],
      ]).toContain(payload);

      assertKMSValidation(loggerInfoSpy);

      jest.restoreAllMocks();
    });
    it("should create the correct JWT for the TokenStatusList", async () => {
      Date.now = jest.fn(() => new Date(Date.UTC(2200, 1, 14)).valueOf());

      mockSQSEvent = createSQSEvent("T2757C3F6091");

      mockDBClient.on(QueryCommand).resolves({
        Items: [
          {
            uri: { S: "T2757C3F6091" },
            idx: { N: "3" },
            clientId: { S: TEST_CLIENT_ID_BITSTRING },
            issuedAt: { N: String(Date.now()) },
            listType: { S: "TokenStatusList" },
            revokedAt: { N: String(Date.now()) },
          },
        ],
      });

      const mockUriItems = <Record<string, AttributeValue>[]>(
        await getUriItems("T2757C3F6091")
      );
      const testJWT = await generateTokenStatusJWT(
        mockUriItems,
        "T2757C3F6091",
        "TokenStatusList",
      );

      expect(testJWT.split(".")).toHaveLength(3);

      const payload = testJWT.split(".")[1];

      expect(payload).toEqual(PUBLISHING_GOLDEN_TOKEN_JWT.split(".")[1]);

      assertKMSValidation(loggerInfoSpy);
    });
  });

  describe("error scenarios", () => {
    it("should return 404 when there is no revoked items for a groupId", async () => {
      mockSQSEvent = createSQSEvent("T2757C3F6091");

      mockDBClient.on(QueryCommand).resolves({
        Items: [],
      });

      const result = await handler(mockSQSEvent, context);

      expect(result).toEqual({
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"error":"NOT_FOUND","error_description":"No revoked items found for uri: T2757C3F6091"}',
      });
    });
    it("should return 404 when there are no items when querying", async () => {
      mockSQSEvent = createSQSEvent("T2757C3F6091");

      mockDBClient.on(QueryCommand).resolves({});

      const result = await handler(mockSQSEvent, context);

      expect(result).toEqual({
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"error":"NOT_FOUND","error_description":"No revoked items found for uri: T2757C3F6091"}',
      });
    });
    it("should return 400 when there is no groupId in the sqs event", async () => {
      mockSQSEvent = createSQSEvent("");

      const result = await handler(mockSQSEvent, context);

      expect(result).toEqual({
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"error":"BAD_REQUEST","error_description":"MessageGroupId is required"}',
      });
    });
    it("should return 500 when there is no groupId in the sqs event", async () => {
      mockSQSEvent = createSQSEvent("");

      const result = await handler(mockSQSEvent, context);

      expect(result).toEqual({
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"error":"BAD_REQUEST","error_description":"MessageGroupId is required"}',
      });
    });
    it("should throw 500 when there there is a error querying the db", async () => {
      mockSQSEvent = createSQSEvent("T2757C3F6091");

      mockDBClient.on(QueryCommand).rejects(new Error("Dynamo db error"));

      await expect(handler(mockSQSEvent, context)).rejects.toThrow(
        "Dynamo db error",
      );
    });
  });
  describe("KMS Error Scenarios", () => {
    const testCases = [
      {
        description: "KMS GetPublicKey fails",
        setup: () =>
          mockKMSClient
            .on(GetPublicKeyCommand)
            .rejects(new Error("KMS GetPublicKey access denied")),
      },
      {
        description: "KMS returns no public key",
        setup: () =>
          mockKMSClient.on(GetPublicKeyCommand).resolves({
            PublicKey: undefined,
            KeyUsage: "SIGN_VERIFY",
            KeySpec: "ECC_NIST_P256",
          }),
      },
      {
        description: "KMS Sign operation fails",
        setup: () => {
          setupValidKmsResponse();
          mockKMSClient
            .on(SignCommand)
            .rejects(new Error("KMS Sign operation failed"));
        },
      },
      {
        description: "KMS Sign returns no signature",
        setup: () => {
          setupValidKmsResponse();
          mockKMSClient.on(SignCommand).resolves({
            Signature: undefined,
            SigningAlgorithm: "ECDSA_SHA_256",
            KeyId: process.env.KMS_SIGNING_KEY_ARN,
          });
        },
      },
    ];

    test.each(testCases)("returns 500 when $description", async ({ setup }) => {
      setup();
      const result = await handler(mockSQSEvent, context);
      expectErrorResponse(result);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "Error generating JWT:",
        expect.any(Error),
      );
    });
  });
  describe("JWT Verification Error Scenarios", () => {
    it("returns 500 when JWT verification fails with bad signature", async () => {
      const { publicKey: goodPublicKey } = await generateKeyPair("ES256");
      const { privateKey: badPrivateKey } = await generateKeyPair("ES256");
      const spkiPem = await exportSPKI(goodPublicKey);
      const spkiGoodPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);

      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: spkiGoodPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });

      await setupKmsSignWithKey(badPrivateKey);

      const result = await handler(mockSQSEvent, context);
      expectErrorResponse(result);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "Error generating JWT:",
        expect.objectContaining({
          message: expect.stringContaining("JWT verification failed"),
        }),
      );
    });
  });

  describe("DER signature edge cases", () => {
    const derTestCases = [
      {
        description: "DER signature is malformed",
        createSignature: createMalformedDerSignature,
      },
      {
        description: "DER signature with leading zeros in R and S",
        createSignature: createDerSignatureWithLeadingZeros,
      },
    ];

    test.each(derTestCases)(
      "returns 500 when $description",
      async ({ createSignature }) => {
        setupValidKmsResponse();
        mockKMSClient.on(SignCommand).resolves({
          Signature: new Uint8Array(createSignature()),
          SigningAlgorithm: "ECDSA_SHA_256",
          KeyId: process.env.KMS_SIGNING_KEY_ARN,
        });

        const result = await handler(mockSQSEvent, context);
        expectErrorResponse(result);
      },
    );
  });

  describe("Environment Variable Error Scenarios", () => {
    const originalEnvKmsArn = process.env.KMS_SIGNING_KEY_ARN;

    afterEach(() => {
      process.env.KMS_SIGNING_KEY_ARN = originalEnvKmsArn;
    });

    it("returns 500 when KMS_SIGNING_KEY_ARN is empty", async () => {
      process.env.KMS_SIGNING_KEY_ARN = "";
      mockKMSClient
        .on(GetPublicKeyCommand)
        .rejects(new Error("Invalid KeyId or ARN"));

      const result = await handler(mockSQSEvent, context);
      expectErrorResponse(result);
    });
  });
  describe("JOSE Library Error Scenarios", () => {
    it("returns 500 when importSPKI fails with malformed public key", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });

      const result = await handler(mockSQSEvent, context);
      expectErrorResponse(result);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "Error generating JWT:",
        expect.objectContaining({
          message: expect.stringContaining("Failed to read asymmetric key"),
        }),
      );
    });
  });
});

function assertKMSValidation(loggerInfoSpy) {
  expect(mockKMSClient.commandCalls(GetPublicKeyCommand)).toHaveLength(1);
  expect(mockKMSClient.commandCalls(SignCommand)).toHaveLength(1);
  expect(loggerInfoSpy).toHaveBeenCalledWith(
    "Successfully retrieved KMS public key",
  );
  expect(loggerInfoSpy).toHaveBeenCalledWith(
    "Successfully signed JWT with KMS",
  );
  expect(loggerInfoSpy).toHaveBeenCalledWith(
    "Successfully verified JWT signature",
  );
}

// To get the nth 2-bit value from the bitstring byte array
export function get2BitValue(arr: Uint8Array, index: number): number {
  const byteIndex = Math.floor(index / 4);
  const bitOffset = (index % 4) * 2;
  return (arr[byteIndex] >> bitOffset) & 0b11;
}

// To get the nth 2-bit value from the token byte array
export function get2BitValueTokenList(arr: Uint8Array, index: number): number {
  const byteIndex = Math.floor(index / 4);
  const bitOffset = (3 - (index % 4)) * 2;
  return (arr[byteIndex] >> bitOffset) & 0b11;
}

// Helper functionsAdd commentMore actions
function pemSpkiToDerUint8Array(pemKey: string): Uint8Array {
  const base64Key = pemKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  return new Uint8Array(Buffer.from(base64Key, "base64"));
}

function createMalformedDerSignature(): Buffer {
  // Malformed DER: missing 0x02 marker for S
  return Buffer.from([
    0x30,
    0x44,
    0x02,
    0x20,
    ...Buffer.alloc(32, 0x01),
    0x03,
    0x20, // Should be 0x02Add commentMore actions
    ...Buffer.alloc(32, 0x02),
  ]);
}

function createDerSignatureWithLeadingZeros(): Buffer {
  const r = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0x01)]);
  const s = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0x02)]);
  return Buffer.concat([
    Buffer.from([0x30, 0x46, 0x02, 0x21]),
    r,
    Buffer.from([0x02, 0x21]),
    s,
  ]);
}
