import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({});
const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

type StatusListItem = {
  uri: { S: string };
  idx?: { N: string };
  clientId?: { S: string };
  exp?: { N: string };
  issuedAt?: { N: string };
  issuer?: { S: string };
  listType?: { S: string };
  revokedAt?: { N: string };
};

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

function badRequestResponse(errorDescription: string): APIGatewayProxyResult {
  return {
    headers: { "Content-Type": "application/json" },
    statusCode: 400,
    body: JSON.stringify({
      error: "BAD_REQUEST",
      error_description: errorDescription,
    }),
  };
}

function notFoundResponse(errorDescription: string): APIGatewayProxyResult {
  return {
    headers: { "Content-Type": "application/json" },
    statusCode: 404,
    body: JSON.stringify({
      error: "NOT_FOUND",
      error_description: errorDescription,
    }),
  };
}

async function queryStatusListEntry(
  uriSuffix: string,
  idx: number,
  expectedListType: string | null,
) {
  try {
    logger.info("Querying DynamoDB for status list entry");
    const queryResult = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: STATUS_LIST_TABLE,
        Key: {
          uri: { S: uriSuffix },
          idx: { N: String(idx) },
        },
      }),
    );

    if (queryResult.Item) {
      const item = queryResult.Item;

      if (!item) {
        logger.error(
          `Entry not found in status list table for URI ${uriSuffix} and index ${idx}`,
        );
        throw new Error("Entry not found in status list table");
      }

      // Check list type if expectedListType is provided
      if (
        expectedListType &&
        (!item.listType || item.listType.S !== expectedListType)
      ) {
        const actualListType = item.listType?.S || "undefined";
        logger.error(
          `List type mismatch: Expected ${expectedListType} but entry has ${actualListType}`,
        );
        throw new Error(
          `List type mismatch: Expected ${expectedListType} but entry has ${actualListType}`,
        );
      }

      return item;
    }

    logger.error(`No entries found in status list table for URI ${uriSuffix}`);
    throw new Error("Entry not found in status list table");
  } catch (error) {
    logger.error(`Error querying DynamoDB: ${error}`);
    throw error;
  }
}

async function updateRevokedAt(
  uriSuffix: string,
  idx: number,
  existingItem: StatusListItem,
) {
  try {
    // Check if revokedAt field already exists and has a value
    if (existingItem.revokedAt && existingItem.revokedAt.N) {
      logger.warn(
        `Item was already revoked at timestamp ${existingItem.revokedAt.N}`,
      );
      return { alreadyRevoked: true, timestamp: existingItem.revokedAt.N };
    }

    // If not revoked, update the revokedAt field
    logger.info("Updating revokedAt field in DynamoDB");
    const currentTime = Math.floor(Date.now() / 1000);
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: STATUS_LIST_TABLE,
        Key: {
          uri: { S: uriSuffix },
          idx: { N: String(idx) },
        },
        UpdateExpression: "SET revokedAt = :revokedAt",
        ExpressionAttributeValues: {
          ":revokedAt": { N: String(currentTime) },
        },
      }),
    );

    return { alreadyRevoked: false, timestamp: currentTime };
  } catch (error) {
    logger.error("Error updating revokedAt field:", error);
    throw new Error("Error updating revokedAt field");
  }
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  setupLogger(context);
  logger.info(LogMessage.REVOKE_LAMBDA_CALLED);

  if (!event.body) {
    logger.error("No Request Body Found");
    return badRequestResponse("No Request Body Found");
  }

  let payload;
  try {
    // payload = decodeJwt(event.body);
    payload = JSON.parse(event.body); //temporary workaround for testing
    logger.info("Successfully decoded JWT as JSON");
  } catch (error) {
    logger.error("Error decoding JWT", error);
    return badRequestResponse("Error decoding JWT");
  }

  const { iss, idx, uri } = payload;
  if (!iss || typeof idx !== "number" || !uri) {
    logger.error("Missing required fields in JWT payload", payload);
    return badRequestResponse("Missing required fields in JWT payload");
  }

  // Extract list type indicator from URI
  const uriParts = uri.split("/");
  const uriSuffix = uriParts.pop();
  const listTypeIndicator = uriParts.length > 0 ? uriParts.pop() : null;
  logger.info(`Extracted URI: ${uriSuffix}, List Type: ${listTypeIndicator}`);

  if (!uriSuffix || !listTypeIndicator) {
    logger.error(`Invalid URI format in JWT payload ${uri}`);
    return badRequestResponse("Invalid URI format in JWT payload");
  }

  // Map URI indicator to expected list type
  const expectedListType =
    listTypeIndicator === "t"
      ? "TokenStatusList"
      : listTypeIndicator === "b"
        ? "BitstringStatusList"
        : null;

  if (!expectedListType) {
    logger.error(`Invalid list type indicator in URI: ${listTypeIndicator}`);
    return badRequestResponse("Invalid list type in URI: must be /t/ or /b/");
  }

  let foundItem;
  try {
    foundItem = await queryStatusListEntry(uriSuffix, idx, expectedListType);
    logger.info(`Found item in table: ${expectedListType} ${uriSuffix} ${idx}`);
  } catch (error) {
    if ((error as Error).message.includes("List type mismatch")) {
      return notFoundResponse((error as Error).message);
    } else if ((error as Error).message.includes("Entry not found")) {
      return notFoundResponse((error as Error).message);
    }
    logger.error(`Error querying DynamoDB: ${error}`);
    return badRequestResponse("Error querying DynamoDB");
  }

  try {
    const updateResult = await updateRevokedAt(uriSuffix, idx, foundItem);

    if (updateResult.alreadyRevoked) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Credential already revoked",
          revokedAt: updateResult.timestamp,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      };
    } else {
      logger.info(
        `Successfully updated revokedAt field in DynamoDB for URI ${uriSuffix} and index ${idx}`,
      );
      return {
        statusCode: 202,
        body: JSON.stringify({
          message: "Request accepted for revocation",
          revokedAt: updateResult.timestamp,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      };
    }
  } catch {
    logger.error("Error updating revokedAt field in DynamoDB");
    return badRequestResponse("Error updating revokedAt field");
  }
}
