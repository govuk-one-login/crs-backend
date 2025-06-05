import { APIGatewayProxyResult } from "aws-lambda";

export const revocationSuccessResponse = (updateResult: {
  alreadyRevoked: boolean;
  timestamp: string;
}) => {
  const baseResponse = {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: updateResult.alreadyRevoked
        ? "Credential already revoked"
        : "Request accepted for revocation",
      revokedAt: updateResult.timestamp,
    }),
  };

  return {
    ...baseResponse,
    statusCode: updateResult.alreadyRevoked ? 200 : 202,
  };
}

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

export const notFoundResponse = (
  errorDescription: string,
): APIGatewayProxyResult => {
  return {
    headers: { "Content-Type": "application/json" },
    statusCode: 404,
    body: JSON.stringify({
      error: "NOT_FOUND",
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
