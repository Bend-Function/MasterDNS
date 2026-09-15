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
    expect(markup).not.toContain('name="awsKind"');
    expect(markup).toContain(`name="${provider === "azure" ? "clientSecret" : "token"}"`);
    expect(markup).not.toContain(provider === "azure" ? "linode-token" : "azure-secret");
    expect(markup).toMatch(/type="password"[^>]*autoComplete="off"/);
  });
});
