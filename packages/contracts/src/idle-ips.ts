export type IdleIpTarget = { region: string; name: string; address: string; arn: string; createdAt: string };
export type IdleIpItem = IdleIpTarget & {
  status: "ready" | "waiting" | "in_flight" | "pending" | "released" | "missing" | "skipped" | "failed";
  reason?: string;
  retryAt?: string;
  dispatchedAt?: string;
  dispatchId?: string;
  operationIds?: string[];
};
export type IdleIpPreview = {
  id: string; accountId: string; regions: string[]; items: IdleIpItem[];
  scanErrors: Array<{ region: string; reason: string }>;
  confirmedAt: string | null; expiresAt: string; createdAt: string;
};
