import { logger } from "../common/logging/logger";
import { LogMessage } from "../common/logging/LogMessages";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {badRequestResponse, internalServerErrorResponse, unauthorizedResponse} from "../common/responses";
import {decodeJwt, decodeProtectedHeader, importJWK, JSONWebKeySet, jwtVerify, KeyLike} from "jose";
import {S3Client} from "@aws-sdk/client-s3";
import {SQSClient} from "@aws-sdk/client-sqs";
import {DynamoDBClient, GetItemCommand} from "@aws-sdk/client-dynamodb";
import {ClientEntry, ClientRegistry, getClientRegistryConfiguration} from "../common/clientRegistryService";
import {fetchJWKS} from "./issueStatusListEntryHandler";
import {decodeJWT} from "../common/jwtService";

function setupLogger(context: Context) {
  logger.resetKeys();
  logger.addContext(context);
  logger.appendKeys({ functionVersion: context.functionVersion });
}

//Used for validation and returning values if successful
interface ValidationResult {
  isValid: boolean;
  signingKey?: KeyLike | Uint8Array<ArrayBufferLike>;
  matchingClientEntry?: ClientEntry;
  error?: APIGatewayProxyResult;
}

const s3Client = new S3Client({});
const dynamoDBClient = new DynamoDBClient({});
const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  setupLogger(context);
  logger.info(LogMessage.REVOKE_LAMBDA_CALLED);

  const decodedJWTPromise = await decodeJWT(event);

  if(decodedJWTPromise.error) {
    return decodedJWTPromise.error;
  }

  const jsonPayload = decodedJWTPromise.payload;
  const jsonHeader = decodedJWTPromise.header;

  const config: ClientRegistry = await getClientRegistryConfiguration(logger, s3Client);

  const validationResult = await validateJWT(<string>event.body, jsonPayload, jsonHeader, config);

  if (!validationResult.isValid && validationResult.error) {
    return validationResult.error;
  }

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

async function validateJWT(
    jwt: string,
    jsonPayload,
    jsonHeader,
    config: ClientRegistry,
): Promise<ValidationResult> {
  if (!jsonPayload.iss) {
    return {
      isValid: false,
      error: badRequestResponse("No Issuer in Payload"),
    };
  }
  if (!jsonPayload.idx) {
    return {
      isValid: false,
      error: badRequestResponse("No Index in Payload"),
    };
  }
  if (!jsonPayload.uri) {
    return {isValid: false, error: badRequestResponse("No URI in Payload")};
  }

  const matchingClientEntry = config.clients.find(
      (i) => i.clientId == jsonPayload.iss,
  );

  if (!matchingClientEntry) {
    return {
      isValid: false,
      error: unauthorizedResponse(
          `No matching client found with ID: ${jsonPayload.iss} `,
      ),
    };
  }

  const jwksUri = matchingClientEntry.statusList.jwksUri;
  if (!jwksUri) {
    return {
      isValid: false,
      matchingClientEntry: matchingClientEntry,
      error: internalServerErrorResponse(
          `No jwksUri found on client ID: ${matchingClientEntry.clientId}`,
      ),
    };
  }
  const jsonWebKeySet: JSONWebKeySet = await fetchJWKS(jwksUri);

  const jwk = jsonWebKeySet.keys.find((key) => key.kid == jsonHeader.kid);
  if (!jwk) {
    return {
      isValid: false,
      matchingClientEntry: matchingClientEntry,
      error: unauthorizedResponse(
          `No matching Key ID found in JWKS Endpoint for Kid: ${jsonHeader.kid}`,
      ),
    };
  }

  const ecPublicKey = await importJWK(
      {
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
        y: jwk.y,
      },
      jwk.alg,
  );

  if (!ecPublicKey) {
    return {
      isValid: false,
      signingKey: ecPublicKey,
      matchingClientEntry: matchingClientEntry,
      error: unauthorizedResponse(
          `No matching Key ID found in JWKS Endpoint for Kid:  ${jsonHeader.kid}`,
      ),
    };
  }

  try {
    await jwtVerify(jwt, ecPublicKey);
  } catch (error) {
    logger.error(`Failure verifying the signature of the jwt: ${error}`);
    return {
      isValid: false,
      signingKey: ecPublicKey,
      matchingClientEntry: matchingClientEntry,
      error: unauthorizedResponse(`Failure verifying the signature of the jwt`),
    };
  }

  const originalIssuerResult = await verifyOriginalIssuer(ecPublicKey, jsonPayload.uri, jsonPayload.idx, jsonPayload.iss)

  if (!originalIssuerResult.isValid) {
    return originalIssuerResult;
  } else {
    return {
      isValid: true
    };
  }
}

async function verifyOriginalIssuer(ecPublicKey, uri: string, idx: number, clientId: string): Promise<ValidationResult> {

  const data = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: STATUS_LIST_TABLE,
        Key: {
          uri: { S: uri },
          idx: { N: String(idx) },
        },
        ProjectionExpression: "clientId"
      }),
  );

  if (!data.Item) {
    return {
      isValid: false,
      error: unauthorizedResponse(`The index hasn't be issued to be revoked`),
    };
  }

  const originalClientId = data.Item.value.S;

  if(!originalClientId) {
    return {
      isValid: false,
      error: unauthorizedResponse(`No client ID found on item: ${data.Item}`),
    };
  } else if (originalClientId != clientId) {
    logger.error("The original clientId is different to the clientId in the request");
    return {
      isValid: false,
      error: unauthorizedResponse(`The original clientId is different to the clientId in the request`),
    };
  }

  return {
    isValid: true
  };
}
