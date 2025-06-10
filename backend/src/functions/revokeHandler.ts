import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ClientRegistry,
  getClientRegistryConfiguration,
} from "./helper/clientRegistryFunctions";
import { decodeJWT, validateRevokingJWT } from "./helper/jwtFunctions";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import {
  revokeFailTXMAEvent,
  revokeSuccessTXMAEvent,
  StatusListItem,
} from "../common/types";
import {
  internalServerErrorResponse,
  notFoundResponse,
  revocationSuccessResponse,
} from "../common/responses";
import { exportJWK } from "jose";
import { sendTxmaEventToSQSQueue } from "./helper/sqsFunctions";
import { SQSClient } from "@aws-sdk/client-sqs";

const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

const sqsClient = new SQSClient({});
const s3Client = new S3Client({});
const dynamoDBClient = new DynamoDBClient({});

/**
 * Revoke Handler
 * @param event
 * @param context
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  setupLogger(context);
  logger.info(LogMessage.REVOKE_LAMBDA_CALLED);

  const decodedJWTPromise = await decodeJWT(event);

  if (decodedJWTPromise.error) {
    return decodedJWTPromise.error;
  }

  const jsonPayload = decodedJWTPromise.payload;
  const jsonHeader = decodedJWTPromise.header;

  const config: ClientRegistry = await getClientRegistryConfiguration(
    logger,
    s3Client,
  );

  const validationResult = await validateRevokingJWT(
    dynamoDBClient,
    <string>event.body,
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
    await sendTxmaEventToSQSQueue(
      sqsClient,
      revokeFailTXMAEvent(
        jsonPayload.iss,
        signingKeyString,
        <string>event.body,
        <APIGatewayProxyResult>validationResult.error,
        jsonHeader.kid,
      ),
    );
    return validationResult.error;
  }

  const foundItem = <StatusListItem>validationResult.dbEntry;
  const statusListEntryIndex = jsonPayload.idx;

  try {
    const updateResult = await updateRevokedAt(
      foundItem.uri.S,
      statusListEntryIndex,
      foundItem,
    );
    logger.info(
      `Revocation process completed for URI ${foundItem.uri.S} and index ${statusListEntryIndex}. Already revoked: ${updateResult.alreadyRevoked}`,
    );

    await sendTxmaEventToSQSQueue(
      sqsClient,
      revokeSuccessTXMAEvent(
        jsonPayload.iss,
        signingKeyString,
        <string>event.body,
        jsonHeader.kid,
      ),
    );

    return revocationSuccessResponse(updateResult);
  } catch (error) {
    const revocationError = handleRevocationError(error as Error);

    await sendTxmaEventToSQSQueue(
      sqsClient,
      revokeFailTXMAEvent(
        jsonPayload.iss,
        signingKeyString,
        <string>event.body,
        <APIGatewayProxyResult>revocationError,
        jsonHeader.kid,
      ),
    );

    return revocationError;
  }
}

function handleRevocationError(error: Error): APIGatewayProxyResult {
  if (error.message.includes("Entry not found")) {
    return notFoundResponse(error.message);
  }

  logger.error("Error during revocation process:", error);
  return internalServerErrorResponse("Error processing revocation request");
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
