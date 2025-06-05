import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  JSONWebKeySet,
  jwtVerify,
  KeyLike,
} from "jose";
import { logger } from "../../common/logging/logger";
import {
  badRequestResponse,
  internalServerErrorResponse,
  unauthorizedResponse,
} from "../../common/responses";
import { ClientEntry, ClientRegistry } from "./clientRegistryFunctions";
import { fetchJWKS } from "../issueStatusListEntryHandler";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { StatusListItem } from "../../common/types";

const STATUS_LIST_TABLE = process.env.STATUS_LIST_TABLE ?? "";

export interface decodedJWT {
  payload?;
  header?;
  error?: APIGatewayProxyResult;
}

//Used for validation and returning values if successful
interface ValidationResult {
  isValid: boolean;
  signingKey?: KeyLike | Uint8Array<ArrayBufferLike>;
  matchingClientEntry?: ClientEntry;
  error?: APIGatewayProxyResult;
}

export async function decodeJWT(
  event: APIGatewayProxyEvent,
): Promise<decodedJWT> {
  let jsonPayload;
  let jsonHeader;

  if (event.body == null) {
    return {
      error: badRequestResponse("No Request Body Found"),
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
      error: badRequestResponse("Error decoding JWT or converting to JSON"),
    };
  }
  return {
    payload: jsonPayload,
    header: jsonHeader,
  };
}

export async function validateIssuingJWT(
  jwt: string,
  jsonPayload,
  jsonHeader,
  config: ClientRegistry,
): Promise<ValidationResult> {
  if (!jsonPayload.expires) {
    return {
      isValid: false,
      error: badRequestResponse("No Expiry Date in Payload"),
    };
  }

  return validateJWT(jwt, jsonPayload, jsonHeader, config);
}

export async function validateRevokingJWT(
  dynamoDBClient: DynamoDBClient,
  jwt: string,
  jsonPayload,
  jsonHeader,
  config: ClientRegistry,
): Promise<ValidationResult> {
  if (!jsonPayload.idx) {
    return {
      isValid: false,
      error: badRequestResponse("No Index in Payload"),
    };
  }

  if (!jsonPayload.uri) {
    return { isValid: false, error: badRequestResponse("No URI in Payload") };
  }

  const commonValidationResult = await validateJWT(
    jwt,
    jsonPayload,
    jsonHeader,
    config,
  );

  if (!commonValidationResult.isValid) {
    return commonValidationResult;
  }

  const originalIssuerResult = await verifyOriginalIssuer(
    dynamoDBClient,
    jsonPayload.uri,
    jsonPayload.idx,
    jsonPayload.iss,
  );

  if (!originalIssuerResult.isValid) {
    return originalIssuerResult;
  }

  return {
    isValid: true,
  };
}

async function validateJWT(
  jwt: string,
  jsonPayload,
  jsonHeader,
  config: ClientRegistry,
): Promise<ValidationResult> {
  if (!jsonHeader.kid) {
    return { isValid: false, error: badRequestResponse("No Kid in Header") };
  }

  if (!jsonPayload.iss) {
    return {
      isValid: false,
      error: badRequestResponse("No Issuer in Payload"),
    };
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

  return {
    isValid: true,
    signingKey: ecPublicKey,
    matchingClientEntry: matchingClientEntry,
  };
}

export async function verifyOriginalIssuer(
  dynamoDBClient: DynamoDBClient,
  uri: string,
  idx: number,
  clientId: string,
): Promise<ValidationResult> {
  const data = await dynamoDBClient.send(
    new GetItemCommand({
      TableName: STATUS_LIST_TABLE,
      Key: {
        uri: { S: uri },
        idx: { N: String(idx) },
      },
      ProjectionExpression: "clientId",
    }),
  );

  const statusListItem = data.Item as StatusListItem;
  if (!statusListItem.idx?.N) {
    return {
      isValid: false,
      error: badRequestResponse(`The index hasn't be issued to be revoked`),
    };
  }

  const originalClientId = statusListItem.clientId;

  if (!originalClientId) {
    return {
      isValid: false,
      error: internalServerErrorResponse(
        `No client ID found on item index: ${statusListItem.idx.N} and uri: ${statusListItem.uri.S}`,
      ),
    };
  } else if (originalClientId.S != clientId) {
    logger.error(
      "The original credential clientId is different to the clientId in the request",
    );
    return {
      isValid: false,
      error: unauthorizedResponse(
        `The original clientId is different to the clientId in the request`,
      ),
    };
  }

  return {
    isValid: true,
  };
}
