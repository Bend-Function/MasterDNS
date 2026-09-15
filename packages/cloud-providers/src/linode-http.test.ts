import { describe, expect, it } from "vitest";
import { LinodeHttp } from "./linode-http.js";

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "X-Customer-UUID": "customer", "X-OAuth-Scopes": "*", ...headers } });
}
describe("Linode HTTP boundaries", () => {
  it("rejects redirects without following a credential-bearing request", async () => {
    let calls = 0;
    const http = new LinodeHttp("secret", async (_url, init) => { calls++; expect(init?.redirect).toBe("manual"); return response({}, 302, { Location: "https://evil.test" }); });
    await expect(http.request("/profile")).rejects.toMatchObject({ code: "remote_identity_changed" }); expect(calls).toBe(1);
  });
  it.each(["//evil.test", "/profile#fragment", "/\\evil.test"])("rejects invalid route %s", async route => {
    const http = new LinodeHttp("secret", async () => { throw new Error("must not run"); });
    await expect(http.request(route)).rejects.toMatchObject({ code: "invalid_rotation_step" });
  });
  it.each([[401, "invalid_credentials"], [403, "permission_denied"], [404, "resource_not_found"], [400, "unknown_cloud_error"]])("normalizes status %s without leaking reason", async (status, code) => {
    const http = new LinodeHttp("secret", async () => response({ errors: [{ reason: "secret" }] }, Number(status)));
    const error = await http.request("/profile").catch(error => error);
    expect(error).toMatchObject({ code, retryable: false }); expect(JSON.stringify(error)).not.toContain("secret");
  });
  it("honors rate limit delay while refusing mutation retries", async () => {
    let calls = 0;
    const http = new LinodeHttp("secret", async () => { calls++; return response({}, 429, { "Retry-After": "12" }); });
    await expect(http.request("/profile")).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 12_000 });
    await expect(http.request("/linode/instances/42/ips", { method: "POST", body: { type: "ipv4", public: true } })).rejects.toMatchObject({ code: "rate_limited", retryable: false, retryAfterMs: 12_000 }); expect(calls).toBe(2);
  });
  it.each(["GET", "POST"] as const)("classifies %s HTML 503 independently of JSON", async method => {
    let calls = 0; const http = new LinodeHttp("secret", async () => { calls++; return new Response("<html>Unavailable</html>", { status: 503 }); });
    await expect(http.request("/linode/instances/42/ips", { method })).rejects.toMatchObject({ code: "temporary_cloud_error", retryable: method === "GET",
      reason: method === "GET" ? "linode_service_unavailable" : "linode_write_outcome_unknown" }); expect(calls).toBe(1);
  });
  it.each(["GET", "POST"] as const)("preserves %s empty 429 retry delay without retrying", async method => {
    let calls = 0; const http = new LinodeHttp("secret", async () => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "17" } }); });
    await expect(http.request("/linode/instances/42/ips", { method })).rejects.toMatchObject({ code: "rate_limited", retryable: method === "GET", retryAfterMs: 17_000 }); expect(calls).toBe(1);
  });
  it.each([[401, "invalid_credentials"], [403, "permission_denied"], [404, "resource_not_found"]] as const)("classifies empty %s responses independently of JSON", async (status, code) => {
    const http = new LinodeHttp("secret", async () => new Response(null, { status }));
    await expect(http.request("/profile")).rejects.toMatchObject({ code, retryable: false });
  });
  it.each(["GET", "POST", "DELETE"] as const)("maps %s interrupted response bodies without claiming no write effect", async method => {
    let calls = 0;
    const http = new LinodeHttp("secret", async () => {
      calls++; const body = new ReadableStream({ start(controller) { controller.error(new DOMException("secret interrupted stream", "AbortError")); } });
      return new Response(body, { status: 200, headers: { "X-Customer-UUID": "customer", "X-OAuth-Scopes": "*" } });
    });
    const error = await http.request("/linode/instances/42/ips", { method }).catch(error => error);
    expect(error).toMatchObject({ code: "temporary_cloud_error", retryable: method === "GET", reason: method === "GET" ? "linode_transport_failed" : "linode_write_outcome_unknown" });
    expect(JSON.stringify(error)).not.toContain("secret"); expect(calls).toBe(1);
  });
  it("retains quota classification from a valid 400 response body", async () => {
    const http = new LinodeHttp("secret", async () => response({ errors: [{ reason: "Additional IPv4 addresses require technical justification" }] }, 400));
    await expect(http.request("/linode/instances/42/ips", { method: "POST" })).rejects.toMatchObject({ code: "quota_exceeded", retryable: false });
  });
  it("reads complete paginated collections including empty intermediate pages", async () => {
    const http = new LinodeHttp("secret", async url => { const page = Number(new URL(String(url)).searchParams.get("page")); return response({ data: page === 2 ? [] : [{ id: page }], page, pages: 3, results: 2 }); });
    expect(await http.all("/account/events")).toEqual([{ id: 1 }, { id: 3 }]);
  });
  it.each(["page", "pages", "results"])("rejects incomplete or changing pagination %s", async key => {
    const http = new LinodeHttp("secret", async url => { const page = Number(new URL(String(url)).searchParams.get("page")); return response({ data: [{ id: page }], page, pages: 2, results: 2, ...(page === 2 ? { [key]: 3 } : {}) }); });
    await expect(http.all("/account/events")).rejects.toBeDefined();
  });
});

it.each(["POST", "DELETE"] as const)("preserves unknown %s effects after invalid successful response evidence", async method => {
  for (const fault of ["missing identity", "wrong identity", "malformed JSON", "invalid shape", "redirect"] as const) {
    let calls = 0;
    const http = new LinodeHttp("secret", async (_url, init) => {
      calls++;
      if (init?.method === "GET") return response({});
      if (fault === "malformed JSON") return new Response("{", { status: 200, headers: { "X-Customer-UUID": "customer" } });
      if (fault === "invalid shape") return response(null);
      if (fault === "redirect") return response({}, 302, { Location: "https://evil.test" });
      return new Response("{}", { status: 200, headers: fault === "wrong identity" ? { "X-Customer-UUID": "other" } : {} });
    });
    await http.request("/profile");
    await expect(http.request("/linode/instances/42/ips", { method })).rejects.toMatchObject({ code: "temporary_cloud_error", retryable: false, reason: "linode_write_outcome_unknown" });
    expect(http.externalAccountId).toBe("customer");
    expect(calls).toBe(2);
  }
});
it.each(["missing", "wrong"] as const)("retains confirmed read identity rejection for a %s customer header", async fault => {
  let calls = 0;
  const http = new LinodeHttp("secret", async () => ++calls === 1 ? response({}) : new Response("{}", { status: 200, headers: fault === "wrong" ? { "X-Customer-UUID": "other" } : {} }));
  await http.request("/profile");
  await expect(http.request("/linode/instances/42")).rejects.toMatchObject({ code: "remote_identity_changed", retryable: false });
});
