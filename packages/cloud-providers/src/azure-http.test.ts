import { describe, expect, it } from 'vitest';
import { AzureHttp } from './azure-http.js';
const credentials = { kind: 'azure_service_principal' as const, tenantId: 'tenant-1', subscriptionId: 'subscription-1', clientId: 'client-1', clientSecret: 'secret +&=' };
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
describe('Azure fixed-host HTTP', () => {
    it('form encodes credentials, scopes ARM, caches tokens and refuses redirects', async () => {
        const calls: Array<{
            url: string;
            init: RequestInit;
        }> = [];
        const http = new AzureHttp(credentials, async (url, init) => {
            calls.push({ url: String(url), init: init! });
            return String(url).includes('login.microsoftonline.com') ? response({ access_token: 'token', expires_in: 3600 }) : response({ value: [] });
        });
        await http.request('/subscriptions/subscription-1/locations?api-version=2022-12-01');
        await http.request('/subscriptions/subscription-1/locations?api-version=2022-12-01');
        expect(calls).toHaveLength(3);
        expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
        const form = new URLSearchParams(String(calls[0]!.init.body));
        expect(Object.fromEntries(form)).toEqual({ client_id: 'client-1', client_secret: 'secret +&=', grant_type: 'client_credentials', scope: 'https://management.azure.com/.default' });
        expect(calls.every(c => c.init.redirect === 'manual')).toBe(true);
        expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe('Bearer token');
    });
    it.each(['https://evil.test/subscriptions/subscription-1', 'https://management.azure.com/subscriptions/other/providers/Microsoft.Network/locations/x/operations/a', 'https://user@management.azure.com/subscriptions/subscription-1', 'https://management.azure.com/subscriptions/subscription-1#frag', 'http://management.azure.com/subscriptions/subscription-1'])('rejects hostile ARM URL %s before token access', async (url) => {
        let calls = 0;
        const http = new AzureHttp(credentials, async () => { calls++; return response({}); });
        await expect(http.request(url)).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(calls).toBe(0);
    });
    it.each([[403, 'permission_denied', false], [409, 'quota_exceeded', false], [429, 'rate_limited', true], [503, 'temporary_cloud_error', true]] as const)('sanitizes and classifies HTTP %s without retrying', async (status, code, retryable) => {
        let requests = 0;
        const http = new AzureHttp(credentials, async (url) => String(url).includes('login.microsoftonline.com') ? response({ access_token: 'token', expires_in: 3600 }) : (requests++, response({ error: { code: 'PublicIPCountLimitReached', message: 'secret +&=' } }, status, { 'retry-after': '2' })));
        await expect(http.request('/subscriptions/subscription-1/resourceGroups/g/providers/Microsoft.Network/publicIPAddresses/a', 'PUT', {})).rejects.toMatchObject({ code, retryable, ...(status === 429 ? { retryAfterMs: 2000 } : {}) });
        expect(requests).toBe(1);
    });
    it('accepts exact resource types and rejects nested or mismatched resource IDs', () => {
        const http = new AzureHttp(credentials);
        const root = '/subscriptions/subscription-1/resourceGroups/g/providers/Microsoft.Network/';
        expect(http.resourceId(root + 'networkInterfaces/nic', 'Microsoft.Network', 'networkInterfaces')).toBe(root + 'networkInterfaces/nic');
        expect(() => http.resourceId(root + 'networkInterfaces/nic/other/child', 'Microsoft.Network', 'networkInterfaces')).toThrow('resource_ownership_ambiguous');
        expect(() => http.resourceId(root + 'virtualNetworks/vnet', 'Microsoft.Network', 'virtualNetworks')).toThrow('resource_ownership_ambiguous');
    });
    it('refuses ARM redirects before following the destination', async () => {
        let armCalls = 0;
        const http = new AzureHttp(credentials, async (url) => String(url).includes('login.microsoftonline.com') ? response({ access_token: 'token', expires_in: 3600 }) : (armCalls++, new Response(null, { status: 307, headers: { location: 'https://evil.test' } })));
        await expect(http.request('/subscriptions/subscription-1')).rejects.toMatchObject({ code: 'resource_ownership_ambiguous' });
        expect(armCalls).toBe(1);
    });
    it('rejects bearer redirects and redacts token errors', async () => {
        const http = new AzureHttp(credentials, async () => response({ error_description: 'secret +&=' }, 401));
        await expect(http.request('/subscriptions/subscription-1')).rejects.toMatchObject({ message: 'invalid_credentials' });
    });
});
