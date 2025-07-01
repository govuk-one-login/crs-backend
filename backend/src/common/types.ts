import { APIGatewayProxyResult } from "aws-lambda";
import { KeyLike } from "jose";
import { ClientEntry } from "../functions/helper/clientRegistryFunctions";

//Used for validation and returning values if successful
export interface ValidationResult {
  isValid: boolean;
  signingKey?: KeyLike | Uint8Array<ArrayBufferLike>;
  matchingClientEntry?: ClientEntry;
  dbEntry?: StatusListItem;
  error?: APIGatewayProxyResult;
}

export type StatusListItem = {
  uri: { S: string };
  idx?: { N: string };
  clientId?: { S: string };
  exp?: { N: string };
  issuedAt?: { N: string };
  issuer?: { S: string };
  listType?: { S: string };
  revokedAt?: { N: string };
};

export interface TxmaEvent {
  timestamp: number;
  event_timestamp_ms: number;
  event_name: EventNames;
  component_id: string;
}

export interface INDEXISSUEDEVENT extends TxmaEvent {
  client_id: string;
  timestamp: number;
  event_timestamp_ms: number;
  event_name: EventNames;
  component_id: string;
  extensions: {
    status_list: {
      signingKey: string;
      keyId: string;
      request: string;
      index: number;
      uri: string;
    };
  };
}

export interface FAILEDEVENT extends TxmaEvent {
  client_id: string;
  timestamp: number;
  event_timestamp_ms: number;
  event_name: EventNames;
  component_id: string;
  extensions: {
    status_list: {
      signingKey: string;
      keyId: string;
      request: string;
      failure_reason: APIGatewayProxyResult;
    };
  };
}

export interface CRSINDEXREVOKED extends TxmaEvent {
  client_id: string;
  timestamp: number;
  event_timestamp_ms: number;
  event_name: EventNames;
  component_id: string;
  extensions: {
    status_list: {
      signingKey: string;
      keyId: string;
      request: string;
    };
  };
}

export type EventNames =
  | "CRS_INDEX_ISSUED"
  | "CRS_ISSUANCE_FAILED"
  | "CRS_INDEX_REVOKED"
  | "CRS_INDEX_REVOCATION_FAILED"
  | "CRS_INDEX_EXPIRED";

export const issueSuccessTXMAEvent = (
  client_id: string,
  signingKey: string,
  keyId: string,
  request: string,
  index: number,
  uri: string,
): INDEXISSUEDEVENT => {
  return {
    client_id: client_id,
    timestamp: Math.floor(Date.now() / 1000),
    event_timestamp_ms: Date.now(),
    event_name: "CRS_INDEX_ISSUED",
    component_id: "https://api.status-list.service.gov.uk",
    extensions: {
      status_list: {
        signingKey: signingKey,
        keyId: keyId,
        request: request,
        index: index,
        uri: uri,
      },
    },
  };
};

export const issueFailTXMAEvent = (
  client_id: string,
  signingKey: string,
  request: string,
  error: APIGatewayProxyResult,
  keyId: string = "null",
): FAILEDEVENT => {
  return {
    client_id: client_id,
    timestamp: Math.floor(Date.now() / 1000),
    event_timestamp_ms: Date.now(),
    event_name: "CRS_ISSUANCE_FAILED",
    component_id: "https://api.status-list.service.gov.uk",
    extensions: {
      status_list: {
        signingKey: signingKey,
        keyId: keyId,
        request: request,
        failure_reason: error,
      },
    },
  };
};

export const revokeSuccessTXMAEvent = (
  client_id: string,
  signingKey: string,
  request: string,
  keyId: string = "null",
): CRSINDEXREVOKED => {
  return {
    client_id: client_id,
    timestamp: Math.floor(Date.now() / 1000),
    event_timestamp_ms: Date.now(),
    event_name: "CRS_INDEX_REVOKED",
    component_id: "https://api.status-list.service.gov.uk",
    extensions: {
      status_list: {
        signingKey: signingKey,
        keyId: keyId,
        request: request,
      },
    },
  };
};

export const revokeFailTXMAEvent = (
  client_id: string,
  signingKey: string,
  request: string,
  error: APIGatewayProxyResult,
  keyId: string = "null",
): FAILEDEVENT => {
  return {
    client_id: client_id,
    timestamp: Math.floor(Date.now() / 1000),
    event_timestamp_ms: Date.now(),
    event_name: "CRS_INDEX_REVOCATION_FAILED",
    component_id: "https://api.status-list.service.gov.uk",
    extensions: {
      status_list: {
        signingKey: signingKey,
        keyId: keyId,
        request: request,
        failure_reason: error,
      },
    },
  };
};

export const bitStringPayload = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  id: "", //uri
  type: ["VerifiableCredential", "BitstringStatusListCredential"],
  iss: "https://crs.account.gov.uk",
  validFrom: "",
  validUntil: "",
  credentialSubject: {
    id: "", //uri
    type: "BitstringStatusList",
    statusSize: 2,
    statusPurpose: "message",
    statusMessage: [
      { status: "0x0", message: "VALID" },
      { status: "0x1", message: "INVALID" },
    ],
    encodedList: "",
  },
};

export const tokenPayload = {
  exp: 0, // representating time to expire in seconds,
  iat: 0, // issued at time in seconds,
  iss: "https://crs.account.gov.uk",
  status_list: {
    bits: 2,
    lst: "",
  },
  sub: "", //uri
  ttl: 43200, // time to live (12 hours)
};
