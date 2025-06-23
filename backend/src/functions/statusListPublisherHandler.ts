import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import { Context } from "aws-lambda";

export function handler(context: Context): Response {
  setupLogger(context);
  logger.info(LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_STARTED);

  logger.info(LogMessage.STATUS_LIST_PUBLISHER_LAMBDA_COMPLETED);
  return new Response(null, {
    status: 501,
    statusText: "Not Implemented",
  });
}

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}