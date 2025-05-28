import { APIGatewayProxyResult } from "aws-lambda";

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

export interface ISSUANCEFAILEDEVENT extends TxmaEvent {
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

export type EventNames =
  | "CRS_INDEX_ISSUED"
  | "CRS_ISSUANCE_FAILED"
  | "CRS_INDEX_REVOKED"
  | "CRS_INDEX_REVOCATION_FAILED"
  | "CRS_INDEX_EXPIRED";
