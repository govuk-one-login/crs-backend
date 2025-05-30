import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  importJWK,
  JSONWebKeySet,
  jwtVerify,
  KeyLike,
} from "jose";
import { Readable } from "stream";
import * as https from "node:https";
import {
  INDEXISSUEDEVENT,
  ISSUANCEFAILEDEVENT,
  TxmaEvent,
} from "../common/types";

// Define types for configuration
interface StatusListEntry {
  jwksUri: string;
  type: string;
  format: string;
}

interface ClientEntry {
  clientName: string;
  clientId: string;
  statusList: StatusListEntry;
}

interface ClientRegistry {
  clients: ClientEntry[];
}

//Used for validation and returning values if successful
interface ValidationResult {
  isValid: boolean;
  signingKey?: KeyLike | Uint8Array<ArrayBufferLike>;
  matchingClientEntry?: ClientEntry;
  error?: APIGatewayProxyResult;
}

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});
const dynamoDBClient = new DynamoDBClient({});

const CONFIG_BUCKET = process.env.CLIENT_REGISTRY_BUCKET ?? "";
const CONFIG_KEY = process.env.CLIENT_REGISTRY_FILE_KEY ?? "";
const TXMA_QUEUE_URL = process.env.TXMA_QUEUE_URL ?? "";
const BITSTRING_QUEUE_URL = process.env.BITSTRING_QUEUE_URL ?? "";
const TOKEN_STATUS_QUEUE_URL = process.env.TOKEN_STATUS_QUEUE_URL ?? "";
const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

/**
 * Main Lambda Handler
 * @param event containing the request which has the issuer and expiry etc.
 * @param context event context
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  setupLogger(context);
  logger.info(LogMessage.ISSUE_LAMBDA_STARTED);

  if (event.body == null) {
    return badRequestResponse("No Request Body Found");
  }

  let jsonPayload;
  let jsonHeader;

  try {
    const payload = decodeJwt(event.body);
    const protectedHeader = decodeProtectedHeader(event.body);

    const payloadString = JSON.stringify(payload);
    const headerString = JSON.stringify(protectedHeader);
    jsonPayload = JSON.parse(payloadString);
    jsonHeader = JSON.parse(headerString);
    logger.info("Succesfully decoded JWT as JSON");
  } catch (error) {
    logger.error("Error decoding or converting to JSON:", error);
    return badRequestResponse("Error decoding JWT or converting to JSON");
  }

  const config: ClientRegistry = await getConfiguration();

  const validationResult = await validateJWT(
    event.body,
    jsonPayload,
    jsonHeader,
    config,
  );

  let signingKeyString = "";
  if (validationResult.signingKey) {
    const jwk = await exportJWK(validationResult.signingKey);
    signingKeyString = JSON.stringify(jwk);
  }

  if (!validationResult.isValid && validationResult.error) {
    await writeToSqs(
      issueFailTXMAEvent(
        jsonPayload.iss,
        signingKeyString,
        event.body,
        validationResult.error,
        jsonHeader.kid,
      ),
    );
    return validationResult.error;
  }

  const matchingClientEntry: ClientEntry = <ClientEntry>(
    config.clients.find((i) => i.clientId == jsonPayload.iss)
  );

  const queueType = getListType(matchingClientEntry);

  const availableIndex = await findNextAvailableIndexPoll(queueType);

  await addCredentialToStatusListTable(
    availableIndex,
    jsonPayload,
    matchingClientEntry,
  );

  await writeToSqs(
    issueSuccessTXMAEvent(
      jsonPayload.iss,
      signingKeyString,
      jsonHeader.kid,
      event.body,
      availableIndex.status_index,
      availableIndex.status_uri,
    ),
  );

  logger.info(LogMessage.SEND_MESSAGE_TO_SQS_SUCCESS);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idx: availableIndex.status_index,
      uri: availableIndex.status_uri,
    }),
  };
}

async function findNextAvailableIndexPoll(getCorrectQueueUrl: string) {
  const availableSlot = await findNextAvailableIndex(getCorrectQueueUrl);

  const data = await dynamoDBClient.send(
    new GetItemCommand({
      TableName: STATUS_LIST_TABLE,
      Key: {
        uri: { S: availableSlot.status_uri },
        idx: { N: String(availableSlot.status_index) },
      },
    }),
  );

  if (!data.Item) {
    logger.info("Index not used yet, returning the available slot");
    return availableSlot;
  } else {
    logger.info("Index already in use, retrying...");
    return findNextAvailableIndexPoll(getCorrectQueueUrl);
  }
}

async function findNextAvailableIndex(queue_url: string | undefined): Promise<{
  status_index: number;
  status_uri: string;
}> {
  let status_uri = "";
  let status_index = -1;

  try {
    const data = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queue_url,
        WaitTimeSeconds: 20,
      }),
    );

    if (data.Messages) {
      for (const message of data.Messages) {
        if (message.Body) {
          const jsonResult = JSON.parse(message.Body);
          status_index = jsonResult.idx;
          status_uri = jsonResult.uri;
          await deleteMessage(message.ReceiptHandle, queue_url);
        } else {
          throw Error("No body in message");
        }
      }
    } else {
      throw Error("No messages received.");
    }
  } catch (error) {
    logger.error("Error receiving messages:", error);
    throw Error("Error receiving messages: " + error);
  }
  return { status_index, status_uri };
}

function getListType(matchingClientEntry: ClientEntry | undefined) {
  if (matchingClientEntry?.statusList.type === "BitstringStatusList") {
    return BITSTRING_QUEUE_URL;
  } else {
    return TOKEN_STATUS_QUEUE_URL;
  }
}

async function deleteMessage(
  receiptHandle: string | undefined,
  queue_url: string | undefined,
) {
  try {
    if (!receiptHandle) {
      logger.error("ReceiptHandle is undefined. Cannot delete message.");
      return;
    }
    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: queue_url,
        ReceiptHandle: receiptHandle,
      }),
    );
    logger.info("Message deleted successfully.");
  } catch (error) {
    logger.error(`Error deleting message: ${error}`, error);
  }
}

async function writeToSqs(txmaEvent: TxmaEvent) {
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: TXMA_QUEUE_URL,
        MessageBody: JSON.stringify(txmaEvent),
      }),
    );
  } catch (error) {
    logger.error(LogMessage.SEND_MESSAGE_TO_SQS_FAILURE, {
      error,
    });
    throw Error(
      `Failed to send TXMA Event: ${txmaEvent} to sqs, error: ${error}`,
    );
  }
}

async function validateJWT(
  jwt: string,
  jsonPayload,
  jsonHeader,
  config: ClientRegistry,
): Promise<ValidationResult> {
  if (!jsonPayload.iss) {
    return {
      isValid: false,
      error: badRequestResponse("No Issuer in Payload"),
    };
  }
  if (!jsonPayload.expires) {
    return {
      isValid: false,
      error: badRequestResponse("No Expiry Date in Payload"),
    };
  }
  if (!jsonHeader.kid) {
    return { isValid: false, error: badRequestResponse("No Kid in Header") };
  }

  const matchingClientEntry = config.clients.find(
    (i) => i.clientId == jsonPayload.iss,
  );

  if (!matchingClientEntry) {
    return {
      isValid: false,
      error: unauthorizedResponse(
        `No matching client found with ID: ${jsonPayload.iss} `,
      ),
    };
  }

  const jwksUri = matchingClientEntry.statusList.jwksUri;
  if (!jwksUri) {
    return {
      isValid: false,
      matchingClientEntry: matchingClientEntry,
      error: internalServerErrorResponse(
        `No jwksUri found on client ID: ${matchingClientEntry.clientId}`,
      ),
    };
  }
  const jsonWebKeySet: JSONWebKeySet = await fetchJWKS(jwksUri);

  const jwk = jsonWebKeySet.keys.find((key) => key.kid == jsonHeader.kid);
  if (!jwk) {
    return {
      isValid: false,
      matchingClientEntry: matchingClientEntry,
      error: unauthorizedResponse(
        `No matching Key ID found in JWKS Endpoint for Kid: ${jsonHeader.kid}`,
      ),
    };
  }

  const ecPublicKey = await importJWK(
    {
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    },
    jwk.alg,
  );

  if (!ecPublicKey) {
    return {
      isValid: false,
      signingKey: ecPublicKey,
      matchingClientEntry: matchingClientEntry,
      error: unauthorizedResponse(
        `No matching Key ID found in JWKS Endpoint for Kid:  ${jsonHeader.kid}`,
      ),
    };
  }

  try {
    await jwtVerify(jwt, ecPublicKey);
  } catch (error) {
    logger.error(`Failure verifying the signature of the jwt: ${error}`);
    return {
      isValid: false,
      signingKey: ecPublicKey,
      matchingClientEntry: matchingClientEntry,
      error: unauthorizedResponse(`Failure verifying the signature of the jwt`),
    };
  }

  return {
    isValid: true,
    signingKey: ecPublicKey,
    matchingClientEntry: matchingClientEntry,
  };
}

/**
 * Helper function to fetch the JWKS from the URI
 */
export async function fetchJWKS(jwksUri): Promise<JSONWebKeySet> {
  return new Promise((resolve, reject) => {
    const req = https.request(jwksUri, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const jwks: JSONWebKeySet = JSON.parse(data);
          resolve(jwks);
        } catch (error) {
          reject(new Error(`Failed to parse JWKS data: ${error.message}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`Failed to fetch JWKS: ${error.message}`));
    });

    req.end();
  });
}

async function addCredentialToStatusListTable(
  result,
  jsonPayload,
  matchingClientEntry: ClientEntry,
) {
  try {
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: STATUS_LIST_TABLE,
        Item: {
          uri: { S: result.status_uri },
          idx: { N: String(result.status_index) },
          clientId: { S: jsonPayload.iss },
          issuedAt: { N: String(Date.now()) },
          exp: { N: jsonPayload.expires },
          issuer: { S: matchingClientEntry.clientName },
          listType: { S: matchingClientEntry.statusList.type },
        },
      }),
    );
  } catch (error) {
    throw new Error(`Error adding credential to status list table:  ${error}`);
  }
}

/**
 * Fetch the configuration from S3
 */
async function getConfiguration() {
  logger.info("Fetching configuration from S3...");
  logger.info(`Bucket: ${CONFIG_BUCKET}, Key: ${CONFIG_KEY}`);
  try {
    const command = new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key: CONFIG_KEY,
    });

    const response = await s3Client.send(command);
    const bodyText = await streamToString(response.Body as Readable);
    logger.info(`Fetched configuration: ${bodyText}`);
    return JSON.parse(bodyText) as ClientRegistry;
  } catch (error) {
    logger.error("Error fetching configuration from S3:", error);
    throw new Error("Error fetching configuration from S3");
  }
}

/**
 * Convert a readable stream to string
 */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

const badRequestResponse = (
  errorDescription: string,
): APIGatewayProxyResult => {
  return {
    headers: { "Content-Type": "application/json" },
    statusCode: 400,
    body: JSON.stringify({
      error: "BAD_REQUEST",
      error_description: errorDescription,
    }),
  };
};

const unauthorizedResponse = (
  errorDescription: string,
): APIGatewayProxyResult => {
  return {
    headers: { "Content-Type": "application/json" },
    statusCode: 401,
    body: JSON.stringify({
      error: "UNAUTHORISED",
      error_description: errorDescription,
    }),
  };
};

const internalServerErrorResponse = (
  errorDescription: string,
): APIGatewayProxyResult => {
  return {
    headers: { "Content-Type": "application/json" },
    statusCode: 500,
    body: JSON.stringify({
      error: "INTERNAL_SERVER_ERROR",
      error_description: errorDescription,
    }),
  };
};

const issueSuccessTXMAEvent = (
  client_id: string,
  signingKey: string,
  keyId: string,
  request: string,
  index: number,
  uri: string,
): INDEXISSUEDEVENT => {
  return {
    client_id: client_id,
    timestamp: Math.floor(Date.now() / 1000),
    event_timestamp_ms: Date.now(),
    event_name: "CRS_INDEX_ISSUED",
    component_id: "https://api.status-list.service.gov.uk",
    extensions: {
      status_list: {
        signingKey: signingKey,
        keyId: keyId,
        request: request,
        index: index,
        uri: uri,
      },
    },
  };
};

const issueFailTXMAEvent = (
  client_id: string,
  signingKey: string,
  request: string,
  error: APIGatewayProxyResult,
  keyId: string = "null",
): ISSUANCEFAILEDEVENT => {
  return {
    client_id: client_id,
    timestamp: Math.floor(Date.now() / 1000),
    event_timestamp_ms: Date.now(),
    event_name: "CRS_ISSUANCE_FAILED",
    component_id: "https://api.status-list.service.gov.uk",
    extensions: {
      status_list: {
        signingKey: signingKey,
        keyId: keyId,
        request: request,
        failure_reason: error,
      },
    },
  };
};
