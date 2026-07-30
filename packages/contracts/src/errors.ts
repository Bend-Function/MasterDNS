export const providerErrorCodes = [
  "authentication_failed",
  "permission_denied",
  "not_found",
  "conflict",
  "validation_failed",
  "rate_limited",
  "transient_failure",
  "unknown_provider_error",
] as const;

export type ProviderErrorCode = (typeof providerErrorCodes)[number];

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly provider: "cloudflare" | "aliyun",
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.retryable = options.retryable ?? ["rate_limited", "transient_failure"].includes(code);
    this.retryAfterMs = options.retryAfterMs;
  }

  readonly retryAfterMs: number | undefined;
}
