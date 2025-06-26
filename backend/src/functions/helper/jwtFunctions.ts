import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  JSONWebKeySet,
  jwtVerify,
} from "jose";
import { logger } from "../../common/logging/logger";
import {
  badRequestResponse,
  internalServerErrorResponse,
  unauthorizedResponse,
} from "../../common/responses";
import { ClientRegistry } from "./clientRegistryFunctions";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import https from "node:https";
import { validateStatusListEntryAgainstRequest } from "./statusListItemFunctions";
import { ValidationResult } from "../../common/types";

export interface DecodedJWT {
  payload?;
  header?;
  error?: APIGatewayProxyResult;
}

export async function decodeJWT(
  event: APIGatewayProxyEvent,
): Promise<DecodedJWT> {
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
  if (!jsonPayload.iat) {
    return {
      isValid: false,
      error: badRequestResponse("No IssuedAt in Payload"),
    };
  }

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

  // Extract and validate URI components
  const uriParts = jsonPayload.uri.split("/");
  const uriSuffix = uriParts.pop();
  const listTypeIndicator = uriParts.pop();

  if (!uriSuffix || !listTypeIndicator) {
    return {
      isValid: false,
      signingKey: commonValidationResult.signingKey,
      error: badRequestResponse("Invalid URI format"),
    };
  }

  const expectedListType = getExpectedListType(listTypeIndicator);
  if (!expectedListType) {
    return {
      isValid: false,
      signingKey: commonValidationResult.signingKey,
      error: badRequestResponse("Invalid list type in URI: must be /t/ or /b/"),
    };
  }

  const originalIssuerResult = await validateStatusListEntryAgainstRequest(
    dynamoDBClient,
    uriSuffix,
    jsonPayload.idx,
    jsonPayload.iss,
    expectedListType,
  );

  if (!originalIssuerResult.isValid) {
    return {
      isValid: false,
      signingKey: commonValidationResult.signingKey,
      error: originalIssuerResult.error,
    };
  }

  return {
    isValid: true,
    signingKey: commonValidationResult.signingKey,
    matchingClientEntry: commonValidationResult.matchingClientEntry,
    dbEntry: originalIssuerResult.dbEntry,
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

/**
 * Helper function to fetch the JWKS from the URI
 */
export async function fetchJWKS(jwksUri): Promise<JSONWebKeySet> {
  return new Promise((resolve, reject) => {
    const req = https.request(jwksUri, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const jwks: JSONWebKeySet = JSON.parse(data);
          resolve(jwks);
        } catch (error) {
          reject(new Error(`Failed to parse JWKS data: ${error.message}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`Failed to fetch JWKS: ${error.message}`));
    });

    req.end();
  });
}

function getExpectedListType(indicator: string): string | null {
  switch (indicator) {
    case "t":
      return "TokenStatusList";
    case "b":
      return "BitstringStatusList";
    default:
      return null;
  }
}
