import axios from "axios";
import axiosRetry from "axios-retry";
import "dotenv/config";
import { aws4Interceptor } from "aws4-axios";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

function getInstance(baseUrl: string, useAwsSigv4Signing: boolean = false) {
  const apiInstance = axios.create({ baseURL: baseUrl });
  axiosRetry(apiInstance, {
    retries: 2,
    retryDelay: (retryCount) => retryCount * 200,
  });
  apiInstance.defaults.validateStatus = () => true;

  if (useAwsSigv4Signing) {
    const interceptor = aws4Interceptor({
      options: {
        region: "eu-west-2",
        service: "execute-api",
      },
      credentials: {
        getCredentials: fromNodeProviderChain({
          timeout: 1000,
          maxRetries: 1,
          profile: process.env.AWS_PROFILE,
        }),
      },
    });
    apiInstance.interceptors.request.use(interceptor);
  }

  return apiInstance;
}
