import { fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { STSClientConfig } from "@aws-sdk/client-sts";

import type { AwsCredentials } from "./provider.js";

export function createAwsCredentialSource(credentials: AwsCredentials): NonNullable<STSClientConfig["credentials"]> {
  if (credentials.kind === "access_key") {
    return credentials.sessionToken === undefined
      ? { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }
      : { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken };
  }

  const base = fromNodeProviderChain();
  if (credentials.roleArn === undefined) return base;
  const params = credentials.externalId === undefined
    ? { RoleArn: credentials.roleArn }
    : { RoleArn: credentials.roleArn, ExternalId: credentials.externalId };
  return fromTemporaryCredentials({ masterCredentials: base, params });
}
