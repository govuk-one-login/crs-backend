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
  describe,
  expect,
  beforeEach,
  jest,
  it,
  afterEach,
} from "@jest/globals";
import { REVOKE_GOLDEN_JWT } from "../../utils/testConstants";
import { LogMessage } from "../../../src/common/logging/LogMessages";
import { generateKeyPair, exportSPKI, exportPKCS8, KeyLike } from "jose";
import crypto from "crypto";

const TEST_KID = "12345678-1234-1234-1234-123456789012";

// Mock logger completely
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

// Mock internalServerErrorResponse to avoid import issues
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

function base64UrlEncode(input: string | Buffer): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function pemSpkiToDerUint8Array(pemKey: string): Uint8Array {
  const base64Key = pemKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const derKeyBuffer = Buffer.from(base64Key, "base64");
  return new Uint8Array(derKeyBuffer);
}

describe("Status List Publisher Handler", () => {
  const mockContext = buildLambdaContext();
  let originalDateNow: () => number;
  let keyPair: { publicKey: KeyLike; privateKey: KeyLike };
  let validKmsPublicKeyDer: Uint8Array;
  let validKmsSignature: Uint8Array;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKMSClient.reset();
    originalDateNow = Date.now;

    // Generate a consistent key pair for all tests
    keyPair = await generateKeyPair("ES256");
    const spkiPem = await exportSPKI(keyPair.publicKey);
    validKmsPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  describe("On every invocation", () => {
    beforeEach(async () => {
      const fixedTimestamp = new Date("2025-06-13T10:00:00.000Z").valueOf();
      Date.now = jest.fn(() => fixedTimestamp);

      // Create a valid DER signature that will work with the JWT verification
      const payload = {
        iss: "https://crs.account.gov.uk",
        sub: "status-list",
        iat: Math.floor(fixedTimestamp / 1000),
        exp: Math.floor(fixedTimestamp / 1000) + 3600,
      };
      const headers = { alg: "ES256", typ: "JWT", kid: TEST_KID };
      const headerEncoded = base64UrlEncode(JSON.stringify(headers));
      const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
      const signingInput = Buffer.from(`${headerEncoded}.${payloadEncoded}`);

      const pkcs8Pem = await exportPKCS8(keyPair.privateKey);
      const signer = crypto.createSign("SHA256");
      signer.update(signingInput);
      const derSignatureBuffer = signer.sign({
        key: pkcs8Pem,
        dsaEncoding: "der",
        format: "pem",
      });
      validKmsSignature = new Uint8Array(derSignatureBuffer);

      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });

      mockKMSClient.on(SignCommand).resolves({
        Signature: validKmsSignature,
        SigningAlgorithm: "ECDSA_SHA_256",
        KeyId: process.env.KMS_SIGNING_KEY_ARN,
      });
    });

    it("logs STARTED message", async () => {
      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      await handler(mockEvent, mockContext);
      expect(logger.info).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_CALLED,
      );
    });

    it("Clears pre-existing log attributes", async () => {
      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      await handler(mockEvent, mockContext);
      expect(logger.resetKeys).toHaveBeenCalledTimes(1);
      expect(logger.addContext).toHaveBeenCalledWith(mockContext);
      expect(logger.appendKeys).toHaveBeenCalledWith({
        functionVersion: mockContext.functionVersion,
      });
    });
  });

  describe("Golden Path", () => {
    beforeEach(async () => {
      const fixedTimestamp = new Date("2025-06-13T10:00:00.000Z").valueOf();
      Date.now = jest.fn(() => fixedTimestamp);

      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const spkiPem = await exportSPKI(publicKey);
      const validKmsPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);

      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: validKmsPublicKeyDer,
        KeyUsage: "SIGN_VERIFY",
        KeySpec: "ECC_NIST_P256",
      });

      const pkcs8Pem = await exportPKCS8(privateKey);

      mockKMSClient
        .on(SignCommand)
        .callsFake(async (input: SignCommandInput) => {
          if (!input.Message) {
            throw new Error("SignCommand mock called without Message");
          }
          const messageToSign = Buffer.from(input.Message);

          const signer = crypto.createSign("SHA256");
          signer.update(messageToSign);
          const derSignatureBuffer = signer.sign({
            key: pkcs8Pem,
            dsaEncoding: "der",
            format: "pem",
          });

          return Promise.resolve({
            Signature: new Uint8Array(derSignatureBuffer),
            SigningAlgorithm: input.SigningAlgorithm || "ECDSA_SHA_256",
            KeyId: input.KeyId || process.env.KMS_SIGNING_KEY_ARN,
          });
        });
    });

    // it("Returns 200 and valid JWT with proper headers", async () => {
    //   const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
    //   const response = await handler(mockEvent, mockContext);

    //   expect(response.statusCode).toBe(200);
    //   expect(response.headers && response.headers["Content-Type"]).toBe("application/jwt");
    //   expect(typeof response.body).toBe("string");
    //   expect(response.body.split(".")).toHaveLength(3);
    //   expect(response.body).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // });

    it("Successfully retrieves KMS public key and signs JWT", async () => {
      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      await handler(mockEvent, mockContext);

      expect(mockKMSClient.commandCalls(GetPublicKeyCommand)).toHaveLength(1);
      expect(mockKMSClient.commandCalls(SignCommand)).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith(
        "Successfully retrieved KMS public key",
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Successfully signed JWT with KMS",
      );
    });

    // it("Handles different request body formats", async () => {
    //   const testCases = [
    //     buildRequest({ body: "" }),
    //     buildRequest({ body: null }),
    //     buildRequest({}),
    //   ];

    //   for (const mockEvent of testCases) {
    //     const response = await handler(mockEvent, mockContext);
    //     expect(response.statusCode).toBe(200);
    //     expect(response.headers && response.headers["Content-Type"]).toBe("application/jwt");
    //   }
    // });
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
      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });

      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual(expectedErrorResponse);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.any(Error),
      );
    });

    it("Returns 500 when KMS returns no public key", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({ PublicKey: undefined });
      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });

      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual(expectedErrorResponse);
    });

    it("Returns 500 when KMS Sign operation fails", async () => {
      const { publicKey } = await generateKeyPair("ES256");
      const spkiPem = await exportSPKI(publicKey);
      mockKMSClient
        .on(GetPublicKeyCommand)
        .resolves({ PublicKey: pemSpkiToDerUint8Array(spkiPem) });
      mockKMSClient
        .on(SignCommand)
        .rejects(new Error("KMS Sign operation failed"));

      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual(expectedErrorResponse);
    });

    it("Returns 500 when KMS Sign returns no signature", async () => {
      const { publicKey } = await generateKeyPair("ES256");
      const spkiPem = await exportSPKI(publicKey);
      mockKMSClient
        .on(GetPublicKeyCommand)
        .resolves({ PublicKey: pemSpkiToDerUint8Array(spkiPem) });
      mockKMSClient.on(SignCommand).resolves({
        Signature: undefined,
        SigningAlgorithm: "ECDSA_SHA_256",
        KeyId: process.env.KMS_SIGNING_KEY_ARN,
      });

      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual(expectedErrorResponse);
    });
  });

  describe("JWT Verification Error Scenarios", () => {
    it("Returns 500 when JWT verification fails with bad signature", async () => {
      const { publicKey: goodPublicKey } = await generateKeyPair("ES256");
      const { privateKey: badPrivateKey } = await generateKeyPair("ES256");

      const spkiPem = await exportSPKI(goodPublicKey);
      const spkiGoodPublicKeyDer = pemSpkiToDerUint8Array(spkiPem);
      mockKMSClient
        .on(GetPublicKeyCommand)
        .resolves({ PublicKey: spkiGoodPublicKeyDer });

      const fixedTimestamp = new Date("2025-06-13T10:00:00.000Z").valueOf();
      Date.now = jest.fn(() => fixedTimestamp);

      const payloadForSigning = {
        iss: "https://crs.account.gov.uk",
        sub: "status-list",
        iat: Math.floor(fixedTimestamp / 1000),
        exp: Math.floor(fixedTimestamp / 1000) + 3600,
      };
      const headersForSigning = { alg: "ES256", typ: "JWT", kid: TEST_KID };
      const headerEncoded = base64UrlEncode(JSON.stringify(headersForSigning));
      const payloadEncoded = base64UrlEncode(JSON.stringify(payloadForSigning));
      const signingInputBuffer = Buffer.from(
        `${headerEncoded}.${payloadEncoded}`,
      );

      const pkcs8BadPrivateKey = await exportPKCS8(badPrivateKey);
      const signer = crypto.createSign("SHA256");
      signer.update(signingInputBuffer);
      const badDerSignature = signer.sign({
        key: pkcs8BadPrivateKey,
        dsaEncoding: "der",
        format: "pem",
      });

      mockKMSClient
        .on(SignCommand)
        .resolves({ Signature: new Uint8Array(badDerSignature) });

      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.objectContaining({
          message: expect.stringContaining("JWT verification failed"),
        }),
      );
    });
  });

  describe("DER Signature Conversion Error Scenarios", () => {
    it("Returns 500 when DER signature is invalid", async () => {
      const { publicKey } = await generateKeyPair("ES256");
      const spkiPem = await exportSPKI(publicKey);
      mockKMSClient
        .on(GetPublicKeyCommand)
        .resolves({ PublicKey: pemSpkiToDerUint8Array(spkiPem) });

      const invalidDerSignature = new Uint8Array([0x30, 0x02, 0x01]);
      mockKMSClient
        .on(SignCommand)
        .resolves({ Signature: invalidDerSignature });

      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
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

      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        error_description: "Failed to generate status list",
      });
    });
  });

  describe("JOSE Library Error Scenarios", () => {
    it("Returns 500 when importSPKI fails with malformed public key", async () => {
      mockKMSClient.on(GetPublicKeyCommand).resolves({
        PublicKey: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      });

      const mockEvent = buildRequest({ body: REVOKE_GOLDEN_JWT });
      const response = await handler(mockEvent, mockContext);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        error_description: "Failed to generate status list",
      });
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.objectContaining({
          message: "Failed to read asymmetric key",
        }),
      );
    });
  });
});
