import {DynamoDBClient, GetItemCommand} from "@aws-sdk/client-dynamodb";
import {StatusListItem} from "../../common/types";
import {
    badRequestResponse,
    internalServerErrorResponse,
    notFoundResponse,
    unauthorizedResponse
} from "../../common/responses";
import {logger} from "../../common/logging/logger";
import {ValidationResult} from "./jwtFunctions";

const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

export async function validateStatusListEntryAgainstRequest(
    dynamoDBClient: DynamoDBClient,
    uri: string,
    idx: number,
    clientId: string,
    expectedListType: string
): Promise<ValidationResult> {

    let data;
    try {
        data = await dynamoDBClient.send(
            new GetItemCommand({
                TableName: STATUS_LIST_TABLE,
                Key: {
                    uri: {S: uri},
                    idx: {N: String(idx)},
                },
                ProjectionExpression: "clientId",
            }),
        );

    } catch(error){
        return {
            isValid: false,
            error: internalServerErrorResponse(`Error querying database: ${error}`)
        }
    }

    const statusListItem = data.Item as StatusListItem;

    if(!statusListItem) {
        return {
            isValid: false,
            error: notFoundResponse("Entry not found in status list table")
        }
    }
    if (!statusListItem.idx?.N) {
        return {
            isValid: false,
            error: badRequestResponse(`The index hasn't be issued to be revoked`),
        };
    }
    // Validate list type
    const actualListType = statusListItem.listType?.S;
    if (actualListType !== expectedListType) {
        return {
            isValid: false,
            error: notFoundResponse(`List type mismatch: Expected ${expectedListType} but entry has ${actualListType ?? "undefined"}`)
        }
    }


    const originalClientId = statusListItem.clientId;

    if (!originalClientId) {
        return {
            isValid: false,
            error: internalServerErrorResponse(
                `No client ID found on item index: ${statusListItem.idx.N} and uri: ${statusListItem.uri.S}`,
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

    logger.info(`Found valid item in table: ${expectedListType} ${statusListItem.uri} ${statusListItem.idx}`);

    return {
        isValid: true,
        dbEntry: statusListItem
    };
}