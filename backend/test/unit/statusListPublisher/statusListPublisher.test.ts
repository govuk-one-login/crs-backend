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

const FIXED_DATE = "2085-06-18T10:00:00.000Z";
const EXPECTED_ERROR_RESPONSE = {
  error: "INTERNAL_SERVER_ERROR",
  error_description: "Failed to generate status list",
};

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

// Helper functions
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
    0x20, // Should be 0x02
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

describe("Status List Publisher Handler", () => {
  let context: Context;
  let event: APIGatewayProxyEvent;
  let keyPair: { publicKey: KeyLike; privateKey: KeyLike };
  let validKmsPublicKeyDer: Uint8Array;
  let originalDateNow: () => number;

  const setupMockDate = (dateString: string = FIXED_DATE) => {
    Date.now = jest.fn(() => new Date(dateString).valueOf());
  };

  const setupValidKmsResponse = () => {
    mockKMSClient.on(GetPublicKeyCommand).resolves({
      PublicKey: validKmsPublicKeyDer,
      KeyUsage: "SIGN_VERIFY",
      KeySpec: "ECC_NIST_P256",
    });
  };

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

  const expectSuccessfulResponse = (result: APIGatewayProxyResult) => {
    expect(result.statusCode).toBe(200);
    expect(result.headers?.["Content-Type"]).toBe("application/jwt");
    expect(typeof result.body).toBe("string");
    expect(result.body.split(".")).toHaveLength(3);
  };

  const expectErrorResponse = (
    result: APIGatewayProxyResult,
    expectedResponse = EXPECTED_ERROR_RESPONSE,
  ) => {
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual(expectedResponse);
  };

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

  describe("On every invocation", () => {
    beforeEach(async () => {
      setupMockDate();
      setupValidKmsResponse();
      await setupKmsSignWithKey(keyPair.privateKey);
    });

    it("logs STARTED message", async () => {
      const result = await handler(event, context);
      expect(logger.info).toHaveBeenCalledWith(
        LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_CALLED,
      );
    });

    it("clears pre-existing log attributes", async () => {
      await handler(event, context);
      expect(logger.resetKeys).toHaveBeenCalledTimes(1);
      expect(logger.addContext).toHaveBeenCalledWith(context);
      expect(logger.appendKeys).toHaveBeenCalledWith({
        functionVersion: context.functionVersion,
      });
    });
  });

  describe("Golden Path", () => {
    beforeEach(async () => {
      setupMockDate();
      setupValidKmsResponse();
      await setupKmsSignWithKey(keyPair.privateKey);
    });

    it("returns 200 and valid JWT with proper headers", async () => {
      const result = await handler(event, context);
      expectSuccessfulResponse(result);
    });

    it("successfully retrieves KMS public key and signs JWT", async () => {
      await handler(event, context);

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

    it.each([
      { description: "empty body", body: "" },
      { description: "null body", body: null },
      { description: "no body", body: undefined },
    ])("handles request with $description", async ({ body }) => {
      const mockEvent = buildRequest({ body });
      const response = await handler(mockEvent, context);
      expectSuccessfulResponse(response);
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
      const result = await handler(event, context);
      expectErrorResponse(result);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
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

      setupMockDate();
      await setupKmsSignWithKey(badPrivateKey);

      const result = await handler(event, context);
      expectErrorResponse(result);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
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

        const result = await handler(event, context);
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

      const result = await handler(event, context);
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

      const result = await handler(event, context);
      expectErrorResponse(result);
      expect(logger.error).toHaveBeenCalledWith(
        "Error in status list publisher:",
        expect.objectContaining({
          message: expect.stringContaining("Failed to read asymmetric key"),
        }),
      );
    });
  });
});
