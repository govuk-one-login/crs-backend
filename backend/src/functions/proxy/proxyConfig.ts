import { LogMessage } from "../../common/logging/LogMessages";
import { logger } from "../../common/logging/logger";
import { Result } from "../../common/types/Result";
import {
  Config,
  getRequiredEnvironmentVariables,
  MissingEnvVarError,
} from "../../common/utils/environment";

const REQUIRED_ENVIRONMENT_VARIABLES = ["PRIVATE_API_URL"] as const;

export type ProxyConfig = Config<
  (typeof REQUIRED_ENVIRONMENT_VARIABLES)[number]
>;

export function getConfigFromEnvironment(
  env: NodeJS.ProcessEnv,
): Result<ProxyConfig, MissingEnvVarError> {
  const envVarsResult = getRequiredEnvironmentVariables(
    env,
    REQUIRED_ENVIRONMENT_VARIABLES,
  );
  if (envVarsResult.isError) {
    logger.error(LogMessage.PROXY_INVALID_CONFIG, {
      data: { missingEnvironmentVariables: envVarsResult.error.missingEnvVars },
    });
  }
  return envVarsResult;
}
