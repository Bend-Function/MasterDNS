import { CloudError } from './errors.js';
import type { AzureCredentials } from './provider.js';
export const ARM_HOST = 'https://management.azure.com';
export const NETWORK_API = '2025-09-01';
export const COMPUTE_API = '2025-04-01';
export const RESOURCE_API = '2022-12-01';
export type AzureResponse = {
    body: Record<string, any>;
    headers: Headers;
    status: number;
};
export const equalArmId = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function retryAfter(headers: Headers): number | undefined {
    const value = headers.get('retry-after');
    if (!value)
        return undefined;
    const duration = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(duration) ? Math.max(0, Math.min(duration, 86400000)) : undefined;
}
/** Fixed-host, single-attempt HTTP. Mutations are never transparently retried. */
export class AzureHttp {
    private token?: {
        value: string;
        expires: number;
    };
    constructor(readonly credentials: AzureCredentials, private readonly fetcher: typeof fetch = fetch) {
        if (![credentials.tenantId, credentials.subscriptionId, credentials.clientId].every(v => /^[A-Za-z0-9-]{1,100}$/.test(v)) || !credentials.clientSecret)
            throw new CloudError('invalid_credentials', false);
    }
    url(path: string): URL {
        let url: URL;
        try {
            url = new URL(path, ARM_HOST);
        }
        catch {
            throw new CloudError('resource_ownership_ambiguous', false);
        }
        const prefix = `/subscriptions/${this.credentials.subscriptionId}`.toLowerCase();
        const normalized = url.pathname.toLowerCase();
        if (url.origin !== ARM_HOST || url.username || url.password || url.hash || !((normalized === prefix) || normalized.startsWith(`${prefix}/`)) || /%|\\|\/\//.test(url.pathname))
            throw new CloudError('resource_ownership_ambiguous', false);
        return url;
    }
    resourceId(value: unknown, provider: 'Microsoft.Compute' | 'Microsoft.Network', resourceType: string): string {
        if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#'))
            throw new CloudError('resource_ownership_ambiguous', false);
        const url = this.url(value);
        const parts = url.pathname.split('/');
        const expectedLength = resourceType === 'virtualNetworks' ? 11 : 9;
        if (parts.length !== expectedLength || parts[3]?.toLowerCase() !== 'resourcegroups' || parts[5]?.toLowerCase() !== 'providers'
            || parts[6]?.toLowerCase() !== provider.toLowerCase() || parts[7]?.toLowerCase() !== resourceType.toLowerCase()
            || parts.some((part, index) => index > 0 && !part) || (resourceType === 'virtualNetworks' && parts[9]?.toLowerCase() !== 'subnets'))
            throw new CloudError('resource_ownership_ambiguous', false);
        return value;
    }
    async request(path: string, method = 'GET', body?: unknown, allow404 = false): Promise<AzureResponse> {
        const url = this.url(path);
        const token = await this.accessToken();
        const result = await this.send(url.href, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (result.status === 404 && allow404)
            return result;
        if (result.status < 200 || result.status >= 300)
            throw this.error(result);
        return result;
    }
    async getResource(id: string, api = NETWORK_API, allow404 = false): Promise<AzureResponse> {
        return this.request(`${id}?api-version=${api}`, 'GET', undefined, allow404);
    }
    private async accessToken(): Promise<string> {
        if (this.token && this.token.expires > Date.now() + 60000)
            return this.token.value;
        const form = new URLSearchParams({ client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret, grant_type: 'client_credentials', scope: `${ARM_HOST}/.default` });
        const response = await this.send(`https://login.microsoftonline.com/${this.credentials.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
        if (response.status < 200 || response.status >= 300 || typeof response.body.access_token !== 'string' || !Number.isFinite(Number(response.body.expires_in)))
            throw new CloudError('invalid_credentials', false);
        this.token = { value: response.body.access_token, expires: Date.now() + Number(response.body.expires_in) * 1000 };
        return this.token.value;
    }
    private async send(url: string, init: RequestInit): Promise<AzureResponse> {
        try {
            const response = await this.fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30000) });
            if (response.status >= 300 && response.status < 400)
                throw new CloudError('resource_ownership_ambiguous', false);
            const raw = await response.text();
            if (raw.length > 8 * 1024 * 1024)
                throw new CloudError('temporary_cloud_error', true);
            let body: Record<string, any> = {};
            if (raw) {
                try {
                    body = JSON.parse(raw);
                }
                catch {
                    throw new CloudError('temporary_cloud_error', true);
                }
            }
            if (!body || typeof body !== 'object' || Array.isArray(body))
                throw new CloudError('temporary_cloud_error', true);
            return { body, headers: response.headers, status: response.status };
        }
        catch (error) {
            if (error instanceof CloudError)
                throw error;
            throw new CloudError('temporary_cloud_error', true);
        }
    }
    private error(result: AzureResponse): CloudError {
        const status = result.status;
        if (status === 401)
            return new CloudError('credentials_expired', false);
        if (status === 403)
            return new CloudError('permission_denied', false);
        if (status === 404)
            return new CloudError('resource_not_found', false);
        if (status === 429)
            return new CloudError('rate_limited', true, retryAfter(result.headers));
        if (status >= 500)
            return new CloudError('temporary_cloud_error', true);
        if (/Quota|LimitReached|LimitExceeded/i.test(String(result.body.error?.code)))
            return new CloudError('quota_exceeded', false);
        return new CloudError('cloud_operation_failed', false);
    }
}
