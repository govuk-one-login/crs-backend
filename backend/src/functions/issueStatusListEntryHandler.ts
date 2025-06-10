import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import { decodeJwt, decodeProtectedHeader, exportJWK } from "jose";
import { issueFailTXMAEvent, issueSuccessTXMAEvent } from "../common/types";
import { badRequestResponse } from "../common/responses";
import { getClientRegistryConfiguration } from "./helper/clientRegistryFunctions";
import { validateIssuingJWT } from "./helper/jwtFunctions";
import { sendTxmaEventToSQSQueue } from "./helper/sqsFunctions";

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
const dynamoDBClient = new DynamoDBClient({});

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

  const config: ClientRegistry = await getClientRegistryConfiguration(
    logger,
    s3Client,
  );

  const validationResult = await validateIssuingJWT(
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
    await sendTxmaEventToSQSQueue(
      sqsClient,
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

  const fullUri = createUri(queueType, availableIndex.status_uri);

  await sendTxmaEventToSQSQueue(
    sqsClient,
    issueSuccessTXMAEvent(
      jsonPayload.iss,
      signingKeyString,
      jsonHeader.kid,
      event.body,
      availableIndex.status_index,
      fullUri,
    ),
  );

  logger.info(LogMessage.SEND_MESSAGE_TO_SQS_SUCCESS);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idx: availableIndex.status_index,
      uri: fullUri,
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
  let status_uri = "https://api.status-list.service.gov.uk/";
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
  } else if (matchingClientEntry?.statusList.type == "TokenStatusList") {
    return TOKEN_STATUS_QUEUE_URL;
  } else {
    throw Error("Client Entry does not have a valid status list type");
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

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

function createUri(queueType: string, status_uri) {
  if (queueType == "BitstringStatusList") {
    return `https://api.status-list.service.gov.uk/b/${status_uri}`;
  } else {
    return `https://api.status-list.service.gov.uk/t/${status_uri}`;
  }
}
