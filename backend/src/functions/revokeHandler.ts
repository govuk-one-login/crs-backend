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
import { StatusListItem } from "../common/types";
import {
  badRequestResponse,
  notFoundResponse,
  revocationSuccessResponse,
} from "../common/responses";

const dynamoDBClient = new DynamoDBClient({});
const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

function getExpectedListType(indicator: string): string | null {
  switch (indicator) {
    case "t":
      return "TokenStatusList";
    case "b":
      return "BitstringStatusList";
    default:
      return null;
  }
}

function handleRevocationError(error: Error): APIGatewayProxyResult {
  if (
    error.message.includes("List type mismatch") ||
    error.message.includes("Entry not found")
  ) {
    return notFoundResponse(error.message);
  }

  logger.error("Error during revocation process:", error);
  return badRequestResponse("Error processing revocation request");
}

async function queryStatusListEntry(
  uriSuffix: string,
  idx: number,
  expectedListType: string,
): Promise<StatusListItem> {
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

    const item = queryResult.Item as StatusListItem;
    if (!item) {
      throw new Error("Entry not found in status list table");
    }

    // Validate list type
    const actualListType = item.listType?.S;
    if (actualListType !== expectedListType) {
      throw new Error(
        `List type mismatch: Expected ${expectedListType} but entry has ${actualListType ?? "undefined"}`,
      );
    }

    return item;
  } catch (error) {
    logger.error("Error querying status list entry:", error);
    throw error;
  }
}

async function updateRevokedAt(
  uriSuffix: string,
  idx: number,
  entry: StatusListItem,
): Promise<{ alreadyRevoked: boolean; timestamp: string }> {
  try {
    // Check if revokedAt field already exists and has a value
    if (entry.revokedAt?.N) {
      logger.warn(`Item was already revoked at timestamp ${entry.revokedAt.N}`);
      return { alreadyRevoked: true, timestamp: entry.revokedAt.N };
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

    return { alreadyRevoked: false, timestamp: String(currentTime) };
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
    return badRequestResponse("No Request Body Found");
  }

  let payload;
  try {
    payload = JSON.parse(event.body); //Using a JSON payload temporarily for testing purposes
    logger.info("Successfully decoded payload");
  } catch (error) {
    logger.error("Error decoding payload:", error);
    return badRequestResponse("Error decoding payload");
  }

  const { iss, idx, uri } = payload;
  if (!iss || typeof idx !== "number" || !uri) {
    return badRequestResponse("Missing required fields: iss, idx, uri");
  }

  // Extract and validate URI components
  const uriParts = uri.split("/");
  const uriSuffix = uriParts.pop();
  const listTypeIndicator = uriParts.pop();

  if (!uriSuffix || !listTypeIndicator) {
    return badRequestResponse("Invalid URI format");
  }

  const expectedListType = getExpectedListType(listTypeIndicator);
  if (!expectedListType) {
    return badRequestResponse("Invalid list type in URI: must be /t/ or /b/");
  }

  try {
    const foundItem = await queryStatusListEntry(
      uriSuffix,
      idx,
      expectedListType,
    );
    logger.info(`Found item in table: ${expectedListType} ${uriSuffix} ${idx}`);

    const updateResult = await updateRevokedAt(uriSuffix, idx, foundItem);
    logger.info(
      `Revocation process completed for URI ${uriSuffix} and index ${idx}. Already revoked: ${updateResult.alreadyRevoked}`,
    );

    return revocationSuccessResponse(updateResult);
  } catch (error) {
    return handleRevocationError(error as Error);
  }
}
