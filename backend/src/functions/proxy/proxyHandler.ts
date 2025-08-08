import {
  APIGatewayProxyEvent,
  APIGatewayProxyEventHeaders,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { logger } from "../../common/logging/logger";
import { LogMessage } from "../../common/logging/LogMessages";
import axios, { AxiosResponseHeaders, RawAxiosResponseHeaders } from "axios";
import { internalServerErrorResponse } from "../../common/responses";
import { getConfigFromEnvironment } from "./proxyConfig";

const ENV = {
  PRIVATE_API_URL: process.env.PRIVATE_API_URL ?? "",
};

export type StandardisedHeaders = {
  [key in string]: string | number | boolean;
};

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  logger.info(LogMessage.PROXY_LAMBDA_STARTED);

  const configResult = getConfigFromEnvironment(process.env);
  if (configResult.isError) {
    return internalServerErrorResponse("Missing environment variables");
  }

  const { path } = event;
  const allowedPaths = ["/issue", "/revoke"];

  if (!allowedPaths.includes(path)) {
    logger.error(LogMessage.PROXY_UNEXPECTED_PATH, {
      errorMessage: `Path is not one of the permitted values: ${path}`,
    });
    return internalServerErrorResponse(
      `Path is not one of the permitted values: ${path}`,
    );
  }

  const httpMethod = event.httpMethod;

  if (httpMethod !== "POST") {
    logger.error(LogMessage.PROXY_UNEXPECTED_HTTP_METHOD, {
      errorMessage: `${httpMethod} request is unexpected, only POST is allowed.`,
    });
    return internalServerErrorResponse("Unexpected HTTP method");
  }

  const incomingHeaders = event.headers;
  const standardisedHeaders = standardiseAndStripApiGwHeaders(incomingHeaders);

  try {
    const response = await axios.post(
      `${ENV.PRIVATE_API_URL}${path}`,
      event.body,
      {
        headers: standardisedHeaders,
        validateStatus: (status: number) => {
          return status < 600;
        },
      },
    );

    logger.info("PROXY_LAMBDA_AXIOS_RESPONSE:", { response: response });

    logger.info(LogMessage.PROXY_LAMBDA_COMPLETED);
    return {
      statusCode: response.status,
      body: JSON.stringify(response.data),
      headers: standardiseAxiosHeaders(response.headers),
    };
  } catch (error) {
    logger.error(LogMessage.PROXY_REQUEST_ERROR, {
      errorMessage: `Error sending network request: ${error}`,
    });
    return internalServerErrorResponse(
      "An error occurred while processing the request.",
    );
  }
}

const standardiseAndStripApiGwHeaders = (
  apiGwHeaders: APIGatewayProxyEventHeaders,
): StandardisedHeaders => {
  const standardisedHeaders: StandardisedHeaders = {};
  if (!apiGwHeaders) return standardisedHeaders;
  const apiGwHeaderKeys = Object.keys(apiGwHeaders);
  apiGwHeaderKeys.forEach((headerKey) => {
    const headerValue = apiGwHeaders[headerKey];
    if (
      typeof headerValue === "string" ||
      typeof headerValue === "number" ||
      typeof headerValue === "boolean"
    ) {
      // This header is sent by the proxy API and should not be included in downstream network requests.
      // The presence of the header causes TLS Certificate failures as the target of the request is not a domain registered on the certificate.

      if (headerKey !== "Host") {
        standardisedHeaders[headerKey] = headerValue;
      }
    }
  });

  return standardisedHeaders;
};

const standardiseAxiosHeaders = (
  axiosResponseHeaders: RawAxiosResponseHeaders | AxiosResponseHeaders,
): StandardisedHeaders => {
  const standardisedHeaders: StandardisedHeaders = {};
  const headerKeys = Object.keys(axiosResponseHeaders);
  headerKeys.forEach((headerKey) => {
    const headerValue = axiosResponseHeaders[headerKey];
    if (
      typeof headerValue === "string" ||
      typeof headerValue === "number" ||
      typeof headerValue === "boolean"
    ) {
      standardisedHeaders[headerKey] = headerValue;
    }
  });

  return standardisedHeaders;
};
