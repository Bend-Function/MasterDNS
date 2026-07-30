export type DdnsInstallPayload = {
  command: string;
  installToken: string;
  expiresAt: string;
};

export function createPreviewDdnsInstall(now = Date.now()): DdnsInstallPayload {
  return {
    command: "curl -fsSL --proto '=https' 'https://dns.internal/api/v1/ddns/install.sh' | sudo sh -s -- install --url 'https://dns.internal'",
    installToken: "preview-one-time-install-token-000000",
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
}
