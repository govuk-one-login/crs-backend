import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

export function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  setupLogger(context);
  logger.info(LogMessage.REVOKE_HANDLER_CALLED);

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
