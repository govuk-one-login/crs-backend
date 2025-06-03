import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { decodeJwt } from "jose";

const dynamoDBClient = new DynamoDBClient({});
const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

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

async function queryStatusListEntry(uriSuffix: string, idx: number) {
  try {
    const queryResult = await dynamoDBClient.send(
      new QueryCommand({
        TableName: STATUS_LIST_TABLE,
        KeyConditionExpression: "uri = :uri and idx = :idx",
        ExpressionAttributeValues: {
          ":uri": { S: uriSuffix },
          ":idx": { N: String(idx) },
        },
      }),
    );
    if (queryResult.Items && queryResult.Items.length > 0) {
      return queryResult.Items[0];
    }
    return null;
  } catch (error) {
    logger.error("Error querying DynamoDB:", error);
    throw new Error("Error querying DynamoDB");
  }
}

async function updateRevokedAt(uriSuffix: string, idx: number) {
  try {
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: STATUS_LIST_TABLE,
        Key: {
          uri: { S: uriSuffix },
          idx: { N: String(idx) },
        },
        UpdateExpression: "SET RevokedAt = :revokedAt",
        ExpressionAttributeValues: {
          ":revokedAt": { N: String(Math.floor(Date.now() / 1000)) },
        },
      }),
    );
  } catch (error) {
    logger.error("Error updating RevokedAt field:", error);
    throw new Error("Error updating RevokedAt field");
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
    // payload = decodeJwt(event.body);
    payload = JSON.parse(event.body);
    logger.info("Successfully decoded JWT as JSON");
  } catch (error) {
    logger.error("Error decoding JWT:", error);
    return badRequestResponse("Error decoding JWT");
  }

  const { iss, idx, uri } = payload;
  if (!iss || typeof idx !== "number" || !uri) {
    return badRequestResponse("Missing required fields in JWT payload");
  }

  const uriSuffix = uri.split("/").pop();
  if (!uriSuffix) {
    return badRequestResponse("Invalid URI format in JWT payload");
  }

  let foundItem;
  try {
    foundItem = await queryStatusListEntry(uriSuffix, idx);
  } catch {
    return badRequestResponse("Error querying DynamoDB");
  }

  if (!foundItem) {
    return notFoundResponse("Entry not found in status list table");
  }

  try {
    await updateRevokedAt(uriSuffix, idx);
  } catch {
    return badRequestResponse("Error updating RevokedAt field");
  }

  return {
    statusCode: 202,
    body: JSON.stringify({
      message: "Request accepted for revocation",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}
