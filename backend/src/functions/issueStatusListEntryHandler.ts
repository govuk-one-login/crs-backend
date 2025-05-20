import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import { importSPKI, JSONWebKeySet, jwtVerify } from "jose";
import { Readable } from "stream";
import * as https from "node:https";
import {
  TxmaEvent,
  INDEX_ISSUED_EVENT,
  ISSUANCE_FAILED_EVENT,
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

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

// S3 bucket and configuration file path
const CONFIG_BUCKET = process.env.CLIENT_REGISTRY_BUCKET ?? "";
const CONFIG_KEY = process.env.CLIENT_REGISTRY_FILE_KEY ?? "";
const TXMA_QUEUE_URL = process.env.TXMA_QUEUE_URL ?? "";

export const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\
    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEVs/o5+uQbTjL3chynL4wXgUg2R9\
q9UU8I5mEovUf86QZ7kOBIjJwqnzD1omageEHWwHdBO6B+dFabmdT9POxg==\
-----END PUBLIC KEY-----"; // REPLACE WITH JWKS ENDPOINT PUBLIC KEY WHEN THATS CREATED

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
    // Parse the JWT without verifying the signature
    const publicKey = await importSPKI(PUBLIC_KEY, "ES256");

    const { payload, protectedHeader } = await jwtVerify(event.body, publicKey);

    const decodedPayload = payload;
    const decodedHeader = protectedHeader;

    const payloadString = JSON.stringify(decodedPayload);
    const headerString = JSON.stringify(decodedHeader);
    jsonPayload = JSON.parse(payloadString);
    jsonHeader = JSON.parse(headerString);
    logger.info("Succesfully decoded JWT as JSON");
  } catch (error) {
    logger.error("Error decoding or converting to JSON:", error);
    return badRequestResponse("Error decoding JWT or converting to JSON");
  }

  const config: ClientRegistry = await getConfiguration();

  const errorResult = await validateJWT(jsonPayload, jsonHeader, config);

  if (errorResult != undefined) {
    await writeToSqs(
      issueFailTXMAEvent(PUBLIC_KEY, jsonHeader.kid, event.body, errorResult),
    );
    return errorResult;
  }

  await writeToSqs(
    issueSuccessTXMAEvent(
      PUBLIC_KEY,
      jsonHeader.kid,
      event.body,
      3,
      "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
    ),
  );

  logger.info(LogMessage.SEND_MESSAGE_TO_SQS_SUCCESS);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idx: 3,
      uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
    }),
  };
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
  jsonPayload,
  jsonHeader,
  config: ClientRegistry,
): Promise<APIGatewayProxyResult | undefined> {
  if (!jsonPayload.iss) {
    return badRequestResponse("No Issuer in Payload");
  }
  if (!jsonPayload.expires) {
    return badRequestResponse("No Expiry Date in Payload");
  }
  if (!jsonHeader.kid) {
    return badRequestResponse("No Kid in Header");
  }

  const matchingClientEntry = config.clients.find(
    (i) => i.clientId == jsonPayload.iss,
  );

  if (!matchingClientEntry) {
    return unauthorizedResponse(
      "No matching client found with ID: " + jsonPayload.iss,
    );
  }
  const jwksUri = matchingClientEntry.statusList.jwksUri;
  if (!jwksUri) {
    return internalServerErrorResponse(
      "No jwksUri found on client ID: " + matchingClientEntry.clientId,
    );
  }
  const jsonWebKeySet: JSONWebKeySet = await fetchJWKS(jwksUri);

  const jwk = jsonWebKeySet.keys.find((key) => key.kid == jsonHeader.kid);
  if (!jwk) {
    return unauthorizedResponse(
      "No matching Key ID found in JWKS Endpoint for Kid: " + jsonHeader.kid,
    );
  }
}

/**
 * Helper function to fetch the JWKS from the URI
 */
async function fetchJWKS(jwksUri): Promise<JSONWebKeySet> {
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
  signingKey: string,
  keyId: string,
  request: string,
  index: number,
  uri: string,
): INDEX_ISSUED_EVENT => {
  return {
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
  signingKey: string,
  keyId: string = "null",
  request: string,
  error: APIGatewayProxyResult,
): ISSUANCE_FAILED_EVENT => {
  return {
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
