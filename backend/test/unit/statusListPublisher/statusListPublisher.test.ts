process.env.KMS_SIGNING_KEY_ARN =
  "arn:aws:kms:eu-west-2:123456789012:key/12345678-1234-1234-1234-123456789012";

import { handler } from "../../../src/functions/statusListPublisherHandler";
import { logger } from "../../../src/common/logging/logger";
import {
  KMSClient,
  GetPublicKeyCommand,
  SignCommand,
  SignCommandInput,
} from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { buildLambdaContext } from "../../utils/mockContext";
import { buildRequest } from "../../utils/mockRequest";
import {
  Context,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import { generateKeyPair, exportSPKI, exportPKCS8, KeyLike } from "jose";
import crypto from "crypto";

// Mock logger
jest.mock("../../../src/common/logging/logger", () => ({
  logger: {
    resetKeys: jest.fn(),
    addContext: jest.fn(),
    appendKeys: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock internalServerErrorResponse
jest.mock("../../../src/common/responses", () => ({
  internalServerErrorResponse: jest.fn((message: string) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      error: "INTERNAL_SERVER_ERROR",
      error_description: message,
    }),
  })),
}));

const mockKMSClient = mockClient(KMSClient);

function pemSpkiToDerUint8Array(pemKey: string): Uint8Array {
  const base64Key = pemKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  return new Uint8Array(Buffer.from(base64Key, "base64"));
}

describe("Status List Publisher Handler", () => {
  let context: Context;
  let event: APIGatewayProxyEvent;
  let keyPair: { publicKey: KeyLike; privateKey: KeyLike };
  let validKmsPublicKeyDer: Uint8Array;
  let originalDateNow: () => number;
  let result: APIGatewayProxyResult;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKMSClient.reset();
    context = buildLambdaContext();
    event = buildRequest();
    originalDateNow = Date.now;
    keyPair = await generateKeyPair("ES256");
    const spkiPem = await exportSPKI(keyPair.publicKey);
    validKmsPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  async function setupKmsSignWithKey(privateKey: KeyLike) {
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
  }

  describe("On every invocation", () => {
    beforeEach(async () => {
      Date.now = jest.fn(() => Date.now());
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      await setupKmsSignWithKey(keyPair.privateKey);
    });

    it("logs STARTED message", async () => {
      result = await handler(event, context);
      expect(logger.info).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_CALLED,
      );
    });

    it("Clears pre-existing log attributes", async () => {
      result = await handler(event, context);
      expect(logger.resetKeys).toHaveBeenCalledTimes(1);
      expect(logger.addContext).toHaveBeenCalledWith(context);
      expect(logger.appendKeys).toHaveBeenCalledWith({
        functionVersion: context.functionVersion,
      });
    });
  });

  describe("Golden Path", () => {
    beforeEach(async () => {
      Date.now = jest.fn(() => new Date("2025-06-18T10:00:00.000Z").valueOf());
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      await setupKmsSignWithKey(keyPair.privateKey);
    });

    it("Returns 200 and valid JWT with proper headers", async () => {
      result = await handler(event, context);
      expect(result.statusCode).toBe(200);
      expect(result.headers && result.headers["Content-Type"]).toBe(
        "application/jwt",
      );
      expect(typeof result.body).toBe("string");
      expect(result.body.split(".")).toHaveLength(3);
      expect(result.body).toMatch(
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
    });

    it("Successfully retrieves KMS public key and signs JWT", async () => {
      result = await handler(event, context);
      expect(mockKMSClient.commandCalls(GetPublicKeyCommand)).toHaveLength(1);
      expect(mockKMSClient.commandCalls(SignCommand)).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith(
        "Successfully retrieved KMS public key",
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Successfully signed JWT with KMS",
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Successfully verified JWT signature",
      );
    });

    it("Handles different request body formats", async () => {
      const testCases = [
        buildRequest({ body: "" }),
        buildRequest({ body: null }),
        buildRequest({}),
      ];
      for (const mockEvent of testCases) {
        const response = await handler(mockEvent, context);
        expect(response.statusCode).toBe(200);
        expect(response.headers && response.headers["Content-Type"]).toBe(
          "application/jwt",
        );
      }
    });
  });

  describe("KMS Error Scenarios", () => {
    const expectedErrorResponse = {
      error: "INTERNAL_SERVER_ERROR",
      error_description: "Failed to generate status list",
    };

    it("Returns 500 when KMS GetPublicKey fails", async () => {
      mockKMSClient
        .on(GetPublicKeyCommand)
        .rejects(new Error("KMS GetPublicKey access denied"));
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual(expectedErrorResponse);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.any(Error),
      );
    });

    it("Returns 500 when KMS returns no public key", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: undefined,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual(expectedErrorResponse);
    });

    it("Returns 500 when KMS Sign operation fails", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      mockKMSClient
        .on(SignCommand)
        .rejects(new Error("KMS Sign operation failed"));
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual(expectedErrorResponse);
    });

    it("Returns 500 when KMS Sign returns no signature", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      mockKMSClient.on(SignCommand).resolves({
        Signature: undefined,
        SigningAlgorithm: "ECDSA_SHA_256",
        KeyId: process.env.KMS_SIGNING_KEY_ARN,
      });
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual(expectedErrorResponse);
    });
  });

  describe("JWT Verification Error Scenarios", () => {
    it("Returns 500 when JWT verification fails with bad signature", async () => {
      const { publicKey: goodPublicKey } = await generateKeyPair("ES256");
      const { privateKey: badPrivateKey } = await generateKeyPair("ES256");
      const spkiPem = await exportSPKI(goodPublicKey);
      const spkiGoodPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: spkiGoodPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      Date.now = jest.fn(() => new Date("2025-06-13T10:00:00.000Z").valueOf());
      await setupKmsSignWithKey(badPrivateKey);
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.objectContaining({
          message: expect.stringContaining("JWT verification failed"),
        }),
      );
    });
  });

  describe("DER signature edge cases", () => {
    it("Returns 500 when DER signature is malformed", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      // Malformed DER: missing 0x02 marker for S
      const der = Buffer.from([
        0x30,
        0x44,
        0x02,
        0x20,
        ...Buffer.alloc(32, 0x01),
        0x03,
        0x20,
        ...Buffer.alloc(32, 0x02),
      ]);
      mockKMSClient.on(SignCommand).resolves({
        Signature: new Uint8Array(der),
        SigningAlgorithm: "ECDSA_SHA_256",
        KeyId: process.env.KMS_SIGNING_KEY_ARN,
      });
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        error_description: "Failed to generate status list",
      });
    });

    it("Handles DER signature with leading zeros in R and S", async () => {
      const r = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0x01)]);
      const s = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0x02)]);
      const der = Buffer.concat([
        Buffer.from([0x30, 0x46, 0x02, 0x21]),
        r,
        Buffer.from([0x02, 0x21]),
        s,
      ]);
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      mockKMSClient.on(SignCommand).resolves({
        Signature: new Uint8Array(der),
        SigningAlgorithm: "ECDSA_SHA_256",
        KeyId: process.env.KMS_SIGNING_KEY_ARN,
      });
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        error_description: "Failed to generate status list",
      });
    });
  });

  describe("Environment Variable Error Scenarios", () => {
    const originalEnvKmsArn = process.env.KMS_SIGNING_KEY_ARN;

    afterEach(() => {
      process.env.KMS_SIGNING_KEY_ARN = originalEnvKmsArn;
    });

    it("Returns 500 when KMS_SIGNING_KEY_ARN is empty", async () => {
      process.env.KMS_SIGNING_KEY_ARN = "";
      mockKMSClient
        .on(GetPublicKeyCommand)
        .rejects(new Error("Invalid KeyId or ARN"));
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        error_description: "Failed to generate status list",
      });
    });
  });

  describe("JOSE Library Error Scenarios", () => {
    it("Returns 500 when importSPKI fails with malformed public key", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });
      result = await handler(event, context);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        error_description: "Failed to generate status list",
      });
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.objectContaining({
          message: expect.stringContaining("Failed to read asymmetric key"),
        }),
      );
    });
  });
});
