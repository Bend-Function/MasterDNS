import { fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { STSClientConfig } from "@aws-sdk/client-sts";

import type { AwsCredentials } from "./provider.js";
import { createAwsRequestHandler } from "./proxy.js";

export const awsClientOptions = {
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true },
} as const;

export function createAwsClientOptions(proxyUrl?: string) {
  const requestHandler = createAwsRequestHandler(proxyUrl);
  return requestHandler === undefined ? awsClientOptions : { maxAttempts: 1 as const, requestHandler };
}

export function createAwsCredentialSource(credentials: AwsCredentials, clientConfig = createAwsClientOptions(credentials.proxyUrl)): NonNullable<STSClientConfig["credentials"]> {
  if (credentials.kind === "access_key") {
    return credentials.sessionToken === undefined
      ? { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }
      : { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken };
  }

  const base = fromNodeProviderChain({ timeout: 3_000, maxRetries: 0, clientConfig });
  if (credentials.roleArn === undefined) return base;
  const params = credentials.externalId === undefined
    ? { RoleArn: credentials.roleArn }
    : { RoleArn: credentials.roleArn, ExternalId: credentials.externalId };
  return fromTemporaryCredentials({ masterCredentials: base, params, clientConfig });
}
