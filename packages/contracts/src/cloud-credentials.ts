import { z } from "zod";

/** Account input only. Runtime proxy credentials belong to the server boundary. */
export const cloudCredentialsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("access_key"), accessKeyId: z.string().trim().min(8).max(128), secretAccessKey: z.string().min(16).max(256), sessionToken: z.string().min(1).max(8192).optional() }).strict(),
  z.object({ kind: z.literal("role"), roleArn: z.string().regex(/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/.+$/).max(2048).optional(), externalId: z.string().min(1).max(1224).optional() }).strict(),
  z.object({ kind: z.literal("azure_service_principal"), tenantId: z.string().uuid(), subscriptionId: z.string().uuid(), clientId: z.string().uuid(), clientSecret: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal("linode_token"), token: z.string().min(1).max(8192) }).strict(),
]);
export type CloudCredentialInput = z.infer<typeof cloudCredentialsSchema>;
export type CloudCredentialKind = CloudCredentialInput["kind"];

/** Presentation metadata only; adminOnly does not replace API authorization. */
export const cloudCredentialDefinitions = {
  access_key: { label: "专用 IAM AccessKey", adminOnly: false, fields: [
    { key: "accessKeyId", label: "AccessKey ID", secret: false, optional: false, trim: false },
    { key: "secretAccessKey", label: "Secret AccessKey", secret: true, optional: false, trim: false },
    { key: "sessionToken", label: "Session Token（可选）", secret: true, optional: true, trim: false },
  ] },
  role: { label: "部署环境身份 / AssumeRole", adminOnly: true, fields: [
    { key: "roleArn", label: "Role ARN（可选）", secret: false, optional: true, trim: false },
    { key: "externalId", label: "External ID（可选）", secret: true, optional: true, trim: false },
  ] },
  azure_service_principal: { label: "Service Principal", adminOnly: false, fields: [
    { key: "tenantId", label: "Tenant ID", secret: false, optional: false, trim: true },
    { key: "subscriptionId", label: "Subscription ID", secret: false, optional: false, trim: true },
    { key: "clientId", label: "Client ID (Application ID)", secret: false, optional: false, trim: true },
    { key: "clientSecret", label: "Client Secret", secret: true, optional: false, trim: false },
  ] },
  linode_token: { label: "Personal Access Token", adminOnly: false, fields: [
    { key: "token", label: "Personal Access Token", secret: true, optional: false, trim: false },
  ] },
} as const satisfies { [Kind in CloudCredentialKind]: { label: string; adminOnly: boolean; fields: readonly { key: Exclude<keyof Extract<CloudCredentialInput, { kind: Kind }>, "kind">; label: string; secret: boolean; optional: boolean; trim: boolean }[] } };
export type CloudCredentialField = (typeof cloudCredentialDefinitions)[CloudCredentialKind]["fields"][number]["key"];
