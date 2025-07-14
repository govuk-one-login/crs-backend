import {
  Context,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import {
  GetPublicKeyCommand,
  KMSClient,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import {
  AttributeValue,
  DynamoDBClient,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  internalServerErrorResponse,
} from "../common/responses";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { importSPKI, jwtVerify, KeyLike } from "jose";
import { bitStringPayload, tokenPayload } from "../common/types";

const kmsClient = new KMSClient({});
const s3Client = new S3Client({});
const STATUS_LIST_BUCKET = process.env.STATUS_LIST_BUCKET ?? "";

const KMS_SIGNING_KEY_ARN = process.env.KMS_SIGNING_KEY_ARN ?? "";
const dynamoDBClient = new DynamoDBClient({});
const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

// 100,000 2-bit values = 200,000 bits = 25,000 bytes
export const numValues = 100000;
const bytesNeeded = Math.ceil(numValues / 4); // 4 values per byte
export async function handler(
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> {
  setupLogger(context);
  //returns any failed messages in the batch to the sqs for reprocessing (up to 10 times)
  const batchItemFailures: SQSBatchItemFailure[] = [];

  logger.info(LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_STARTED);
  const groupIdMap = createGroupIdToMessageIdsMap(event, batchItemFailures);
  if (groupIdMap.size === 0) {
    logger.error("No valid group IDs found in the SQS event records.");
    return { batchItemFailures };
  }

  logger.info(`Group ID Map: ${JSON.stringify(groupIdMap)}`);

  for (const groupId of groupIdMap.keys()) {
    logger.info(`Processing Group ID: ${groupId}`);

    let jwt = "";
    const revokedUriItems = await getUriItems(groupId);

    if (!revokedUriItems || revokedUriItems.length === 0) {
      logger.error(`No revoked items found for uri: ${groupId}`);
      const failedMessageIds = groupIdMap.get(groupId) || [];
      failedMessageIds.forEach((messageId) => {
        batchItemFailures.push({ itemIdentifier: messageId });
      });
      continue;
    }

    const firstItem = revokedUriItems[0];
    const groupType = firstItem.listType?.S;

    try {
      if (groupType == "BitstringStatusList") {
        jwt = await generateBitStringJWT(
          revokedUriItems,
          groupId,
          "BitstringStatusList",
        );
      } else if (groupType == "TokenStatusList") {
        jwt = await generateTokenStatusJWT(
          revokedUriItems,
          groupId,
          "TokenStatusList",
        );
      } else {
        logger.error(`The group Id has an invalid type: ${groupType}`);
        const failedMessageIds = groupIdMap.get(groupId) || [];
        failedMessageIds.forEach((messageId) => {
          batchItemFailures.push({ itemIdentifier: messageId });
        });
      }
    } catch (error) {
      logger.error("Error generating JWT:", error);
      const failedMessageIds = groupIdMap.get(groupId) || [];
      failedMessageIds.forEach((messageId) => {
        batchItemFailures.push({ itemIdentifier: messageId });
      });
    }

    logger.info(`JWT successfully generated for groupId: ${groupId}`);

    try {
      await publishJWT(groupType, jwt, groupId);
    } catch (error) {
      logger.error(`Error publishing JWT to S3: ${error}`);
      const failedMessageIds = groupIdMap.get(groupId) || [];
      failedMessageIds.forEach((messageId) => {
        batchItemFailures.push({ itemIdentifier: messageId });
      });
    }

    logger.info(
      `JWT successfully published to S3 for groupId: ${groupId}, groupType: ${groupType}`,
    );
  }

  logger.info(LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_COMPLETED);

  return { batchItemFailures: batchItemFailures };
}

async function publishJWT(
  groupType: string | undefined,
  jwt: string,
  groupId: string,
) {
  const key =
    groupType == "BitstringStatusList" ? `b/${groupId}` : `t/${groupId}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: STATUS_LIST_BUCKET,
      Key: key,
      Body: jwt,
      ContentType: "application/jwt",
    }),
  );
}

function setupLogger(context: Context) {
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

function setupTokenPayload(uri: string, encodedList: string) {
  const payload = tokenPayload;
  payload.iat = Math.floor(Date.now() / 1000);
  payload.exp = payload.iat + payload.ttl;
  payload.sub = `https://api.status-list.service.gov.uk/t/${uri}`;
  payload.status_list.lst = encodedList;

  return payload;
}

function setupBitStringPayload(uri: string, encodedList: string) {
  const payload = bitStringPayload;
  payload.validFrom = new Date().toISOString();
  payload.validUntil = payload.validUntil = new Date(
    new Date(payload.validFrom).getTime() + 43200,
  ).toISOString(); // 12 hours from validFrom
  payload.id = `https://api.status-list.service.gov.uk/b/${uri};`;
  payload.credentialSubject.id = `https://api.status-list.service.gov.uk/b/${uri}`;
  payload.credentialSubject.encodedList = encodedList;

  return payload;
}

async function createAndSignJWT(
  encodedList: string,
  uri: string,
  payloadType: string,
): Promise<string> {
  const payload =
    payloadType == "BitstringStatusList"
      ? setupBitStringPayload(uri, encodedList)
      : setupTokenPayload(uri, encodedList);

  const headers = {
    alg: "ES256",
    typ: "JWT",
    kid: KMS_SIGNING_KEY_ARN.split("/").pop() ?? "status-list-key",
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
  logger.info("Successfully signed JWT with KMS");

  if (!res.Signature) {
    throw new Error("KMS signing failed - no signature returned");
  }

  logger.info("KMS signing successful");

  const jwtSignature = convertDerToJwtSignature(res.Signature);

  const jwt = `${headerEncoded}.${payloadEncoded}.${jwtSignature}`;

  logger.info("JWT created:", {
    header: headerEncoded,
    payload: payloadEncoded,
    signature: jwtSignature,
    fullJWT: jwt,
  });

  const publicKey = await getKMSPublicKey();
  logger.info("Successfully retrieved KMS public key");

  await verifyJWT(jwt, publicKey);

  logger.info("Successfully verified JWT signature");
  return jwt;
}

export async function getUriItems(groupId: string) {
  try {
    const result = await dynamoDBClient.send(
      new QueryCommand({
        TableName: STATUS_LIST_TABLE,
        KeyConditionExpression: "uri = :uriVal",
        FilterExpression: "attribute_exists(revokedAt)",
        ExpressionAttributeValues: {
          ":uriVal": { S: groupId },
        },
      }),
    );

    return result.Items;
  } catch (error) {
    throw Error(`Error querying DynamoDB: ${error}`);
  }
}

export async function generateBitStringJWT(
  revokedUriItems: Record<string, AttributeValue>[],
  groupId: string,
  groupType: string,
) {
  const byteArray = generateByteArray(revokedUriItems);
  const compressedAndEncodedByteArray = await compressAndEncode(
    byteArray,
    "gzip",
  );

  return await createAndSignJWT(
    compressedAndEncodedByteArray,
    groupId,
    groupType,
  );
}

export async function generateTokenStatusJWT(
  revokedUriItems: Record<string, AttributeValue>[],
  groupId: string,
  groupType: string,
) {
  const byteArray = generateTokenByteArray(revokedUriItems);
  const compressedAndEncodedByteArray = await compressAndEncode(
    byteArray,
    "deflate",
  );
  return await createAndSignJWT(
    compressedAndEncodedByteArray,
    groupId,
    groupType,
  );
}

export function generateByteArray(
  revokedItems: Record<string, AttributeValue>[],
) {
  const byteArray = new Uint8Array(bytesNeeded); // All values default to 0 (00)

  // Iterate through the items and set the bitstring values
  revokedItems.forEach((item) => {
    const idx = item.idx?.N;
    if (!idx) {
      return internalServerErrorResponse("Index does not exist in the item");
    }
    const index = parseInt(idx, 10);
    set2BitValueBitstringList(byteArray, index, 0b01);
    logger.info(
      `Setting index ${index} to revoked (BitStringStatusList) ${get2BitValueAsBitString(0b01)}`,
    );
  });

  logger.info(`Byte Array: ${Array.from(byteArray)}`);

  return byteArray;
}

export function generateTokenByteArray(
  revokedItems: Record<string, AttributeValue>[],
) {
  const byteArray = new Uint8Array(bytesNeeded); // All values default to 0 (00)

  // Iterate through the items and set the bitstring values
  revokedItems.forEach((item) => {
    const idx = item.idx?.N;
    if (!idx) {
      return internalServerErrorResponse("Index does not exist in the item");
    }
    const index = parseInt(idx, 10);
    set2BitValueTokenList(byteArray, index, 0b01);
    logger.info(
      `Setting index ${index} to revoked (TokenStatusList) ${get2BitValueAsBitString(0b01)}`,
    );
  });

  logger.info(`Byte Array: ${Array.from(byteArray)}`);

  return byteArray;
}

// To set the nth 2-bit value to a value (0-3)
function set2BitValueBitstringList(
  arr: Uint8Array,
  index: number,
  value: number,
) {
  const byteIndex = Math.floor(index / 4); // Each byte holds 4 2-bit values
  const bitOffset = (index % 4) * 2; // Calculate the bit offset within the byte
  arr[byteIndex] &= ~(0b11 << bitOffset); // Clear the 2 bits - inverted mask so it keeps the 1s in other bits
  arr[byteIndex] |= (value & 0b11) << bitOffset; // Set new value
}

// To set the nth 2-bit value to a value (0-3)
function set2BitValueTokenList(arr: Uint8Array, index: number, value: number) {
  const byteIndex = Math.floor(index / 4); // Each byte holds 4 2-bit values
  const bitOffset = (3 - (index % 4)) * 2; // Calculate the bit offset within the byte, reversed order for token list
  arr[byteIndex] &= ~(0b11 << bitOffset); // Clear the 2 bits
  arr[byteIndex] |= (value & 0b11) << bitOffset; // Set new value
}

function get2BitValueAsBitString(value: number): string {
  return value.toString(2).padStart(2, "0");
}

async function verifyJWT(jwt: string, publicKey: KeyLike): Promise<void> {
  try {
    const verificationResult = await jwtVerify(jwt, publicKey, {
      issuer: "https://crs.account.gov.uk",
      algorithms: ["ES256"],
    }); //using the same issuer as in the mock payload
    logger.debug("JWT verification payload:", verificationResult.payload);
  } catch (error) {
    throw new Error(`JWT verification failed: ${error.message}`);
  }
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
  const pem = base64.match(/.{1,64}/g)?.join("\n") ?? "";
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

export async function compressAndEncode(dataToBeCompressed, compresstionType) {
  const byteArray = new TextEncoder().encode(dataToBeCompressed);
  const cs = new CompressionStream(compresstionType);
  const writer = cs.writable.getWriter();
  writer.write(byteArray);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return Buffer.from(compressed).toString("base64");
}

function createGroupIdToMessageIdsMap(
  event: SQSEvent,
  batchItemFailures: SQSBatchItemFailure[],
) {
  const groupIdMap = new Map<string, string[]>();

  for (const record of event.Records) {
    logger.info(`Processing SQS record: ${JSON.stringify(record)}`);
    const groupId = record?.attributes?.MessageGroupId;
    const messageId = record?.messageId;

    logger.info(
      `Processing message with ID: ${messageId}, Group ID: ${groupId}`,
    );
    if (!groupId) {
      logger.error(
        `MessageGroupId is missing in the following messageID: ${messageId}`,
      );
      batchItemFailures.push({ itemIdentifier: messageId });
    } else {
      groupIdMap.set(groupId, [...(groupIdMap.get(groupId) || []), messageId]);
    }
  }
  return groupIdMap;
}
