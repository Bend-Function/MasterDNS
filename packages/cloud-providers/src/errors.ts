export type CloudErrorCode =
  | "rotation_unsupported"
  | "invalid_rotation_step"
  | "resource_ownership_ambiguous"
  | "cleanup_not_authorized"
  | "cloud_operation_failed"
  | "cloud_writes_not_enabled"
  | "credentials_expired"
  | "invalid_credentials"
  | "invalid_cursor"
  | "permission_denied"
  | "quota_exceeded"
  | "rate_limited"
  | "remote_identity_changed"
  | "resource_not_found"
  | "temporary_cloud_error"
  | "unknown_cloud_error";

export class CloudError extends Error {
  readonly name = "CloudError";

  constructor(
    readonly code: CloudErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly reason?: string,
  ) {
    super(code);
  }

  toJSON(): { name: string; code: CloudErrorCode; retryable: boolean; retryAfterMs?: number; reason?: string } {
    return { name: this.name, code: this.code, retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }
}

type AwsErrorShape = {
  name?: string;
  Code?: string;
  code?: string;
  retryAfterSeconds?: number;
  $retryable?: { throttling?: boolean };
};

export function normalizeAwsError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const value = typeof error === "object" && error !== null ? error as AwsErrorShape : {};
  const name = value.name ?? value.Code ?? value.code ?? "";
  const retryAfterMs = typeof value.retryAfterSeconds === "number" ? value.retryAfterSeconds * 1_000 : undefined;

  if (name === "ExpiredToken" || name === "ExpiredTokenException" || name === "RequestExpired") {
    return new CloudError("credentials_expired", false);
  }
  if (name === "InvalidClientTokenId" || name === "UnrecognizedClientException" || name === "SignatureDoesNotMatch") {
    return new CloudError("invalid_credentials", false);
  }
  if (name === "AccessDenied" || name === "AccessDeniedException" || name === "UnauthorizedOperation") {
    return new CloudError("permission_denied", false);
  }
  if (value.$retryable?.throttling || /Throttl|TooManyRequests|RequestLimitExceeded/.test(name)) {
    return new CloudError("rate_limited", true, retryAfterMs);
  }
  if (/Quota|LimitExceeded|AddressLimitExceeded/.test(name)) {
    return new CloudError("quota_exceeded", false);
  }
  if (/Timeout|Networking|Connection|ServiceUnavailable|InternalError|InternalFailure/.test(name)) {
    return new CloudError("temporary_cloud_error", true);
  }
  if (/NotFound|InvalidInstanceID\.NotFound/.test(name)) {
    return new CloudError("resource_not_found", false);
  }
  return new CloudError("unknown_cloud_error", false);
}
