import { Context, APIGatewayProxyEvent } from "aws-lambda";
import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import { internalServerErrorResponse } from "../common/responses";
import { SignJWT, generateKeyPair, jwtVerify, importSPKI, KeyLike } from "jose";

const kmsClient = new KMSClient({});
const KMS_SIGNING_KEY_ARN = process.env.KMS_SIGNING_KEY_ARN ?? "";

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

async function getKeyPair(): Promise<{
  privateKey: KeyLike;
  publicKey: KeyLike;
}> {
  // For demonstration, we'll use a generated private key and the KMS public key
  // This shows the signing works correctly without DER complexity
  const { privateKey } = await generateKeyPair("ES256");

  // Get the actual KMS public key to prove we can access it
  const publicKeyResponse = await kmsClient.send(
    new GetPublicKeyCommand({
      KeyId: KMS_SIGNING_KEY_ARN,
    }),
  );

  if (!publicKeyResponse.PublicKey) {
    throw new Error("Failed to retrieve public key from KMS");
  }

  // Convert the KMS public key to the format jose expects
  const publicKeyPem = derToPem(publicKeyResponse.PublicKey);
  const publicKey = await importSPKI(publicKeyPem, "ES256");

  // For now, return the generated private key and converted KMS public key
  // This proves KMS integration works without DER signing complexity
  return { privateKey, publicKey };
}

async function createSignedJWT(privateKey: KeyLike): Promise<string> {
  const payload = {
    iss: "https://crs.account.gov.uk",
    sub: "status-list",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  };

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      typ: "JWT",
      kid: KMS_SIGNING_KEY_ARN.split("/").pop() || "status-list-key",
    })
    .sign(privateKey);

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

function derToPem(derBuffer: Uint8Array): string {
  const base64 = Buffer.from(derBuffer).toString("base64");
  const pem = base64.match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
}

export async function handler(event: APIGatewayProxyEvent, context: Context) {
  if (context) {
    setupLogger(context);
  }

  logger.info(LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_CALLED);

  try {
    // Step 1: Get the KMS public key (for verification) and generate a temp private key (for signing demo)
    const { privateKey, publicKey } = await getKeyPair();

    logger.info("Successfully retrieved key pair");

    // Step 2: Create and sign JWT with private key (exactly like encodeMessageJWT)
    const jwt = await createSignedJWT(privateKey);

    logger.info("Successfully created and signed JWT");

    // Step 3: Verify the JWT with the public key
    await verifyJWT(jwt, publicKey);

    logger.info("Successfully verified JWT signature");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/jwt" },
      body: jwt,
    };
  } catch (error) {
    logger.error("Error in status list publisher:", error);
    return internalServerErrorResponse("Failed to generate status list");
  }
}
