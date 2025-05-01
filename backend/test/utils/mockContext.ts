import { Context } from "aws-lambda";

export function buildLambdaContext(): Context {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: "lambdaFunctionName",
    functionVersion: "1",
    invokedFunctionArn: "arn:12345",
    memoryLimitInMB: "1028",
    awsRequestId: "awsRequestId",
    logGroupName: "logGroup",
    logStreamName: "logStream",
  };
}
