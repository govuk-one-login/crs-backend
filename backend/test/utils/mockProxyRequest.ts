// This file contains a mock proxy request object for testing purposes.
import {APIGatewayProxyEvent} from "aws-lambda";

// eslint-disable-next-line
export function buildProxyRequest(overrides?: any): APIGatewayProxyEvent {
    const mockProxyRequest = {
        resource: "/{proxy+}",
        path: "/issue",
        httpMethod: "POST",
        headers: {
            Host: "api.status-list.service.gov.uk",
            Accept: "application/json",
            "Content-Type": "application/jwt",
        },
        body: {"mock body": "this is a mock body"},
        status: 200,
    }
    return {...mockProxyRequest, ...overrides};

}