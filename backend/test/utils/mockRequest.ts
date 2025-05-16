import { APIGatewayProxyEvent } from "aws-lambda";

// eslint-disable-next-line
export function buildRequest(overrides?: any): APIGatewayProxyEvent {
  const defaultRequest = {
    method: "POST",
    url: "/issue",
    headers: {
      Host: "api.status-list.service.gov.uk",
      Accept: "application/json",
    },
    body: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6ImNjMmMzNzM4LTAzZWMtNDIxNC1hNjVlLTdmMDQ2MWEzNGU3YiJ9.eyJpc3MiOiJhc0tXbnNqZUVKRVdqandTSHNJa3NJa3NJaEJlIiwiZXhwaXJlcyI6IjE3MzQ3MDk0OTMifQ.OlAm7TIfn-Qrs2yJvl6MDr9raiq_uZ6FV7WwaPz2CTuCuK-EkvsqM8139yjIiJq3pqeZk0S_23J-4SGBAkUXhA",
  };
  return { ...defaultRequest, ...overrides };
}
