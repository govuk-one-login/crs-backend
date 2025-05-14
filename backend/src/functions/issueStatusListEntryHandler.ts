import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import { decodeJwt, decodeProtectedHeader, JSONWebKeySet } from "jose";
import { Readable } from "stream";
import * as https from "node:https";

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

// S3 bucket and configuration file path
const CONFIG_BUCKET = process.env.CLIENT_REGISTRY_BUCKET || "";
const CONFIG_KEY =
  process.env.CLIENT_REGISTRY_FILE_KEY || "mockClientRegistry.json";

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  setupLogger(context);
  logger.info(LogMessage.ISSUE_LAMBDA_STARTED);

  if (event.body != null) {
    let jsonPayload;
    let jsonHeader;

    try {
      // Parse the JWT without verifying the signature
      const decodedPayload = decodeJwt(event.body);
      const decodedHeader = decodeProtectedHeader(event.body);

      const payloadString = JSON.stringify(decodedPayload);
      const headerString = JSON.stringify(decodedHeader);
      jsonPayload = JSON.parse(payloadString);
      jsonHeader = JSON.parse(headerString);
      logger.info("Succesfully decoded JWT as JSON");
    } catch (error) {
      logger.error("Error decoding or converting to JSON:", error);
      return badRequestResponse("Error decoding JWT or converting to JSON");
    }
    if (!jsonPayload.iss) {
      return badRequestResponse("No Issuer in Payload");
    }
    if (!jsonPayload.expires) {
      return badRequestResponse("No Expiry Date in Payload");
    }
    if (!jsonHeader.kid) {
      return badRequestResponse("No Kid in Header");
    }

    const config: ClientRegistry = await getConfiguration();

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
    const jsonWebKeySet: JSONWebKeySet = await fetchJWKS(
      "https://mobile.dev.account.gov.uk/.well-known/jwks.json",
    );

    const jwk = jsonWebKeySet.keys.find((key) => key.kid == jsonHeader.kid);
    if (!jwk) {
      return unauthorizedResponse(
        "No matching Key ID found in JWKS Endpoint for Kid: " + jsonHeader.kid,
      );
    }
  } else {
    return badRequestResponse("No Request Body Found");
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idx: 3,
      uri: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
    }),
  };
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

    req.end(); // Important: Send the request
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
    throw error;
  }
}

/**
 * Convert a readable stream to string
 */
async function streamToString(stream: Readable): Promise<string> {
  logger.info("Converting stream to string...");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  logger.info("Stream converted to string successfully");
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
