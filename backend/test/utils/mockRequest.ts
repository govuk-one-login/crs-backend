import { APIGatewayProxyEvent } from "aws-lambda";
import { ISSUE_GOLDEN_JWT } from "./testConstants";

// eslint-disable-next-line
export function buildRequest(overrides?: any): APIGatewayProxyEvent {
  const defaultRequest = {
    method: "POST",
    url: "/issue",
    headers: {
      Host: "api.status-list.service.gov.uk",
      Accept: "application/json",
    },
    body: ISSUE_GOLDEN_JWT,
  };
  return { ...defaultRequest, ...overrides };
}
