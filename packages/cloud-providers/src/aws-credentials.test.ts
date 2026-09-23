import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const providers = vi.hoisted(() => ({
  node: vi.fn(() => async () => ({ accessKeyId: "base", secretAccessKey: "base-secret" })),
  temporary: vi.fn(() => async () => ({ accessKeyId: "temporary", secretAccessKey: "temporary-secret" })),
}));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: providers.node,
  fromTemporaryCredentials: providers.temporary,
}));

import { awsClientOptions, createAwsClientOptions, createAwsCredentialSource } from "./aws-credentials.js";

describe("AWS proxy options", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the single-attempt bounded direct transport", () => {
    expect(createAwsClientOptions()).toBe(awsClientOptions);
    expect(createAwsClientOptions()).toMatchObject({ maxAttempts: 1, requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true } });
  });

  it("creates a Smithy handler for SOCKS and validates role STS routing", () => {
    const options = createAwsClientOptions("socks5h://user:pass@proxy.example:1080");
    expect(options.maxAttempts).toBe(1);
    expect(options.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(() => createAwsCredentialSource({ kind: "role", roleArn: "arn:aws:iam::123456789012:role/test", proxyUrl: "http://proxy.example" })).toThrow("Invalid SOCKS proxy URL");
  });

  it("passes the SOCKS transport to the default chain and explicit role STS clients", () => {
    const options = createAwsClientOptions("socks5h://proxy.example:1080");
    createAwsCredentialSource({ kind: "role", roleArn: "arn:aws:iam::123456789012:role/test", proxyUrl: "socks5h://proxy.example:1080" }, options);
    expect(providers.node).toHaveBeenCalledWith({ timeout: 3_000, maxRetries: 0, clientConfig: options });
    expect(providers.temporary).toHaveBeenCalledWith(expect.objectContaining({ clientConfig: options }));
  });
});
