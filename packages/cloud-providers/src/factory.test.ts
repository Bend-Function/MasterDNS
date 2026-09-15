import { expect, it } from "vitest";
import * as cloud from "./index.js";

const azure = { kind: "azure_service_principal" as const, tenantId: "tenant", subscriptionId: "subscription", clientId: "client", clientSecret: "secret" };
const linode = { kind: "linode_token" as const, token: "secret" };
it("dispatches Azure VM and Linode to their real adapters", () => {
  expect(cloud.createCloudAdapter({ accountId: "account", service: "azure_vm", provider: "azure", credentials: azure })).toBeInstanceOf(cloud.AzureCloudAdapter);
  expect(cloud.createCloudAdapter({ accountId: "account", service: "linode", provider: "linode", credentials: linode })).toBeInstanceOf(cloud.LinodeCloudAdapter);
});
it.each([
  { service: "azure_vm", provider: "aws", credentials: azure },
  { service: "azure_vm", provider: "azure", credentials: linode },
  { service: "linode", provider: "azure", credentials: linode },
  { service: "ec2", provider: "aws", credentials: azure },
  { service: "unknown", provider: "aws", credentials: { kind: "role" } },
])("rejects mismatched or unknown cloud dispatch: $service / $provider", config => {
  expect(() => cloud.createCloudAdapter({ accountId: "account", ...config } as never)).toThrow();
});
