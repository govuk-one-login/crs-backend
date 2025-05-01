import { APIGatewayProxyEvent } from "aws-lambda";
import { randomUUID } from "crypto";

function getHeaderCaseInsensitive(
  event: APIGatewayProxyEvent,
  headerSearchTerm: string,
): string | undefined {
  const [, headerValue] =
    Object.entries(event.headers).find(
      ([key]) => key.toLowerCase() === headerSearchTerm.toLowerCase(),
    ) ?? [];
  return headerValue;
}

export const getCorrelationIdFromApiGatewayEvent = (
  event: APIGatewayProxyEvent,
): string => {
  return (
    getHeaderCaseInsensitive(event, "x-correlation-id") ??
    event.requestContext.requestId ??
    randomUUID()
  );
};
