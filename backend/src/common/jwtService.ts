
import {APIGatewayProxyEvent, APIGatewayProxyResult} from "aws-lambda";
import {decodeJwt, decodeProtectedHeader} from "jose";
import {logger} from "./logging/logger";
import {badRequestResponse} from "./responses";

export interface decodedJWT {
    payload?;
    header?;
    error?: APIGatewayProxyResult;
}

export async function decodeJWT(event: APIGatewayProxyEvent): Promise<decodedJWT> {
    let jsonPayload;
    let jsonHeader;


    if (event.body == null) {
        return {
            error: badRequestResponse("No Request Body Found")
        };
    }

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
        return {
            error: badRequestResponse("Error decoding JWT or converting to JSON")
        }
    }
    return {
        payload: jsonPayload,
        header: jsonHeader
    }
}
