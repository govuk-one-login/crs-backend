import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { StatusListItem, ValidationResult } from "../../common/types/types";
import {
  internalServerErrorResponse,
  notFoundResponse,
  unauthorizedResponse,
} from "../../common/responses";
import { logger } from "../../common/logging/logger";

const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

export async function validateStatusListEntryAgainstRequest(
  dynamoDBClient: DynamoDBClient,
  uriSuffix: string,
  idx: number,
  clientId: string,
  expectedListType: string,
): Promise<ValidationResult> {
  let data;
  try {
    data = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: STATUS_LIST_TABLE,
        Key: {
          uri: { S: uriSuffix },
          idx: { N: String(idx) },
        },
      }),
    );
  } catch (error) {
    return {
      isValid: false,
      error: internalServerErrorResponse(`Error querying database: ${error}`),
    };
  }

  const statusListItem = data.Item as StatusListItem;

  if (!statusListItem) {
    return {
      isValid: false,
      error: notFoundResponse("Entry not found in status list table"),
    };
  }

  // Validate list type
  const actualListType = statusListItem.listType?.S;
  if (actualListType !== expectedListType) {
    return {
      isValid: false,
      error: notFoundResponse(
        `List type mismatch: Expected ${expectedListType} but entry has ${actualListType ?? "undefined"}`,
      ),
    };
  }

  const originalClientId = statusListItem.clientId;

  if (!originalClientId) {
    return {
      isValid: false,
      error: internalServerErrorResponse(
        `No client ID found on item index: ${statusListItem.idx?.N} and uri: ${statusListItem.uri.S}`,
      ),
    };
  } else if (originalClientId.S != clientId) {
    logger.error(
      "The original credential clientId is different to the clientId in the request",
    );
    return {
      isValid: false,
      error: unauthorizedResponse(
        `The original clientId is different to the clientId in the request`,
      ),
    };
  }

  logger.info(
    `Found valid item in table: ${expectedListType} ${JSON.stringify(statusListItem.uri)} ${JSON.stringify(statusListItem.idx)}`,
  );

  return {
    isValid: true,
    dbEntry: statusListItem,
  };
}
