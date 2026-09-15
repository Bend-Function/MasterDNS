import { CloudError } from "./errors.js";

const origin = "https://api.linode.com/v4";
const maxPages = 1_000;
export class LinodeHttp {
  externalAccountId?: string;
  permissionScopes: string[] = [];
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async request<T>(path: string, options: { method?: "GET" | "POST" | "DELETE"; body?: unknown; filter?: Record<string, unknown> } = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) throw new CloudError("invalid_rotation_step", false);
    const method = options.method ?? "GET";
    // A dispatched mutation is never automatically retried, including 429 and 5xx.
    let response: Response;
    try {
      response = await this.fetcher(`${origin}${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.filter ? { "X-Filter": JSON.stringify(options.filter) } : {}) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch { throw new CloudError("temporary_cloud_error", method === "GET", undefined, method === "GET" ? "linode_transport_failed" : "linode_write_outcome_unknown"); }
    if (response.status >= 300 && response.status < 400) throw new CloudError("remote_identity_changed", false, undefined, "linode_redirect_refused");
    // Status and retry headers remain authoritative even when an error body is empty, HTML, or interrupted.
    let statusError: CloudError | undefined;
    if (!response.ok) {
      if (response.status === 401) statusError = new CloudError("invalid_credentials", false);
      else if (response.status === 403) statusError = new CloudError("permission_denied", false);
      else if (response.status === 404) statusError = new CloudError("resource_not_found", false);
      else if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1_000 - Date.now();
        const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Number.isFinite(reset) && reset > 0 ? reset : undefined;
        statusError = new CloudError("rate_limited", method === "GET", delay);
      } else if (response.status >= 500) statusError = new CloudError("temporary_cloud_error", method === "GET", undefined, method === "GET" ? "linode_service_unavailable" : "linode_write_outcome_unknown");
      else statusError = new CloudError("unknown_cloud_error", false);
    }
    let body: string;
    try { body = await response.text(); }
    catch { throw statusError ?? new CloudError("temporary_cloud_error", method === "GET", undefined, method === "GET" ? "linode_transport_failed" : "linode_write_outcome_unknown"); }
    let data: unknown;
    try { data = JSON.parse(body); }
    catch { throw statusError ?? new CloudError("unknown_cloud_error", false, undefined, "linode_invalid_response"); }
    if (statusError) {
      const error = data as { errors?: Array<{ reason?: string }> };
      const quota = Array.isArray(error?.errors) && error.errors.some(e => typeof e?.reason === "string" && /additional IPv4.*technical justification|IPv4.*quota|IP address.*limit/i.test(e.reason));
      if (response.status === 400 && quota) throw new CloudError("quota_exceeded", false, undefined, "linode_additional_ipv4_requires_approval");
      throw statusError;
    }
    const uuid = response.headers.get("X-Customer-UUID")?.trim();
    if (!uuid || (this.externalAccountId !== undefined && uuid !== this.externalAccountId)) throw new CloudError("remote_identity_changed", false);
    this.externalAccountId = uuid;
    this.permissionScopes = (response.headers.get("X-OAuth-Scopes") ?? "").split(/[\s,]+/).filter(Boolean);
    if (data === null || typeof data !== "object") throw new CloudError("unknown_cloud_error", false, undefined, "linode_invalid_response");
    return data as T;
  }

  async page<T>(path: string, page: number, filter?: Record<string, unknown>): Promise<{ data: T[]; page: number; pages: number; results: number }> {
    if (!Number.isSafeInteger(page) || page < 1 || page > maxPages) throw new CloudError("invalid_cursor", false);
    const result = await this.request<{ data: T[]; page: number; pages: number; results: number }>(`${path}?page=${page}&page_size=100`, filter ? { filter } : {});
    if (!Array.isArray(result.data) || result.page !== page || !Number.isSafeInteger(result.pages) || result.pages < page || result.pages > maxPages || !Number.isSafeInteger(result.results) || result.results < 0) throw new CloudError("unknown_cloud_error", false, undefined, "linode_incomplete_pagination");
    return result;
  }

  async all<T>(path: string, filter?: Record<string, unknown>): Promise<T[]> {
    const items: T[] = [];
    let page = 1, expectedPages: number | undefined, expectedResults: number | undefined;
    for (;;) {
      const result = await this.page<T>(path, page, filter);
      if ((expectedPages !== undefined && result.pages !== expectedPages) || (expectedResults !== undefined && result.results !== expectedResults)) throw new CloudError("temporary_cloud_error", true, undefined, "linode_inventory_changed_during_pagination");
      expectedPages = result.pages; expectedResults = result.results; items.push(...result.data);
      if (page === result.pages) break;
      page++;
    }
    if (items.length !== expectedResults) throw new CloudError("temporary_cloud_error", true, undefined, "linode_incomplete_pagination");
    return items;
  }
}
