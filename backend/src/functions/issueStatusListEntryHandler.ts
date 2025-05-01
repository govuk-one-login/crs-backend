import {APIGatewayProxyResult, APIGatewayProxyEvent, Context } from 'aws-lambda';
import { logger } from '../common/logging/logger'
import { LogMessage } from '../common/logging/LogMessages'


export async function handler(context: Context, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {  
  
  setupLogger(context);
  logger.info(LogMessage.ISSUE_LAMBDA_STARTED);

  return {
    statusCode: 200,
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      'idx': 3,
      'uri': "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD" }),
  };
}

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}
  