import {APIGatewayProxyResult} from "aws-lambda";

export const badRequestResponse = (
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

export const unauthorizedResponse = (
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

export const internalServerErrorResponse = (
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