import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  ClientRegistry,
  getClientRegistryConfiguration,
} from "./helper/clientRegistryFunctions";
import { decodeJWT, validateRevokingJWT } from "./helper/jwtFunctions";

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

const s3Client = new S3Client({});
const dynamoDBClient = new DynamoDBClient({});

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

  if (!validationResult.isValid && validationResult.error) {
    return validationResult.error;
  }

  return Promise.resolve({
    statusCode: 202,
    body: JSON.stringify({
      message: "Request accepted for revocation",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  });
}
