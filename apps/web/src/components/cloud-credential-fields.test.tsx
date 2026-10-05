import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyCredentialDraft } from "../lib/cloud-credentials";
import { CloudCredentialFields } from "./cloud-credential-fields";

describe("cloud credential field rendering", () => {
  it.each(["azure", "linode"] as const)("renders only %s fields and masks secrets", (provider) => {
    const markup = renderToStaticMarkup(createElement(CloudCredentialFields, {
      draft: { ...emptyCredentialDraft(provider), clientSecret: "azure-secret", token: "linode-token", secretAccessKey: "hidden-aws-secret" },
      setDraft: () => undefined, changeKind: () => undefined, admin: true, disabled: false,
    }));
    expect(markup).not.toContain("hidden-aws-secret");
    expect(markup).not.toContain('name="credentialKind"');
    expect(markup).toContain(`name="${provider === "azure" ? "clientSecret" : "token"}"`);
    expect(markup).not.toContain(provider === "azure" ? "linode-token" : "azure-secret");
    expect(markup).toMatch(/type="password"[^>]*autoComplete="off"/);
  });
});

it("renders AWS auth choices for administrators and isolates role-only fields", () => {
  const markup = renderToStaticMarkup(createElement(CloudCredentialFields, {
    draft: { ...emptyCredentialDraft(), credentialKind: "role", externalId: "fake-external", secretAccessKey: "hidden-access-secret" },
    setDraft: () => undefined, changeKind: () => undefined, admin: true, disabled: true,
  }));
  expect(markup).toContain('value="access_key"');
  expect(markup).toContain('value="role"');
  expect(markup).toContain('name="roleArn"');
  expect(markup.match(/<input[^>]*name="externalId"[^>]*>/)?.[0]).toContain('type="password"');
  expect(markup).not.toContain("hidden-access-secret");
  expect(markup).not.toContain('name="sessionToken"');
  const userMarkup = renderToStaticMarkup(createElement(CloudCredentialFields, {
    draft: emptyCredentialDraft(), setDraft: () => undefined, changeKind: () => undefined, admin: false, disabled: false,
  }));
  expect(userMarkup).not.toContain('name="credentialKind"');
  expect(userMarkup).toContain('name="accessKeyId"');
});
