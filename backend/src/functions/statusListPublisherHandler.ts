import { Context, APIGatewayProxyEvent } from "aws-lambda";
import {
  KMSClient,
  GetPublicKeyCommand,
  SignCommand,
  MessageType,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import { internalServerErrorResponse } from "../common/responses";
import { jwtVerify, importSPKI, KeyLike } from "jose";

const kmsClient = new KMSClient({});
const KMS_SIGNING_KEY_ARN = process.env.KMS_SIGNING_KEY_ARN ?? "";

export async function handler(event: APIGatewayProxyEvent, context: Context) {
  setupLogger(context);

  logger.info(LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_CALLED);

  try {
    const publicKey = await getKMSPublicKey();
    logger.info("Successfully retrieved KMS public key");

    const jwt = await createAndSignJWT();
    logger.info("Successfully signed JWT with KMS");

    await verifyJWT(jwt, publicKey);
    logger.info("Successfully verified JWT signature");

    return buildSuccessResponse(jwt);
  } catch (error) {
    logger.error("Error in status list publisher:", error);
    return internalServerErrorResponse("Failed to generate status list");
  }
}

function setupLogger(context?: Context) {
  if (!context) return;
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

async function getKMSPublicKey(): Promise<KeyLike> {
  const publicKeyResponse = await kmsClient.send(
    new GetPublicKeyCommand({ KeyId: KMS_SIGNING_KEY_ARN }),
  );

  if (!publicKeyResponse.PublicKey) {
    throw new Error("Failed to retrieve public key from KMS");
  }

  const publicKeyPem = derToPem(publicKeyResponse.PublicKey);

  logger.info("KMS public key retrieved:", {
    keyLength: publicKeyResponse.PublicKey.length,
    keyUsage: publicKeyResponse.KeyUsage,
    keySpec: publicKeyResponse.KeySpec,
    publicKeyPem,
  });

  return importSPKI(publicKeyPem, "ES256");
}

async function createAndSignJWT(): Promise<string> {
  const payload = {
    iss: "https://crs.account.gov.uk",
    sub: "status-list",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }; //synthetic payload for now

  const headers = {
    alg: "ES256",
    typ: "JWT",
    kid: KMS_SIGNING_KEY_ARN.split("/").pop() || "status-list-key",
  };

  const headerEncoded = base64UrlEncode(JSON.stringify(headers));
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signingInput = Buffer.from(`${headerEncoded}.${payloadEncoded}`);

  const signCommand = new SignCommand({
    KeyId: KMS_SIGNING_KEY_ARN,
    Message: signingInput,
    SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
    MessageType: MessageType.RAW,
  });

  const res = await kmsClient.send(signCommand);

  if (!res.Signature) {
    throw new Error("KMS signing failed - no signature returned");
  }

  logger.info("KMS signing result:", {
    signatureLength: res.Signature.length,
    signingAlgorithm: res.SigningAlgorithm,
    keyId: res.KeyId,
    signatureBase64: Buffer.from(res.Signature).toString("base64"),
  });

  const jwtSignature = convertDerToJwtSignature(res.Signature);

  const jwt = `${headerEncoded}.${payloadEncoded}.${jwtSignature}`;

  logger.info("Final JWT created:", {
    header: headerEncoded,
    payload: payloadEncoded,
    signature: jwtSignature,
    fullJWT: jwt,
  });

  return jwt;
}

async function verifyJWT(jwt: string, publicKey: KeyLike): Promise<void> {
  try {
    const verificationResult = await jwtVerify(jwt, publicKey, {
      issuer: "https://crs.account.gov.uk",
      algorithms: ["ES256"],
    });
    logger.debug("JWT verification payload:", verificationResult.payload);
  } catch (error) {
    throw new Error(`JWT verification failed: ${error.message}`);
  }
}

function buildSuccessResponse(jwt: string) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/jwt" },
    body: jwt,
  };
}

function base64UrlEncode(input: string | Buffer): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function derToPem(derBuffer: Uint8Array): string {
  const base64 = Buffer.from(derBuffer).toString("base64");
  const pem = base64.match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
}

function convertDerToJwtSignature(derSignature: Uint8Array): string {
  const signature = Buffer.from(derSignature);
  let offset = 2; // Skip 0x30 and total length

  // Parse R
  if (signature[offset] !== 0x02)
    throw new Error("Invalid DER signature format");
  offset++;
  const rLength = signature[offset++];
  let r = signature.subarray(offset, offset + rLength);
  offset += rLength;

  // Parse S
  if (signature[offset] !== 0x02)
    throw new Error("Invalid DER signature format");
  offset++;
  const sLength = signature[offset++];
  let s = signature.subarray(offset, offset + sLength);

  // Remove leading zero bytes if present (DER encoding adds them for positive integers)
  while (r.length > 0 && r[0] === 0x00) r = r.subarray(1);
  while (s.length > 0 && s[0] === 0x00) s = s.subarray(1);

  // Ensure r and s are exactly 32 bytes (for P-256)
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  if (r.length < 32) r = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  if (s.length < 32) s = Buffer.concat([Buffer.alloc(32 - s.length), s]);

  const rawSignature = Buffer.concat([r, s]);
  return rawSignature
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
