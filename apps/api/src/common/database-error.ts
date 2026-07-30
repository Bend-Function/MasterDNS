export type PublicDatabaseError = { status: number; code: string; message: string };

export function publicDatabaseError(error: unknown): PublicDatabaseError | null {
  const postgresCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (postgresCode === "23505") return { status: 409, code: "conflict", message: "资源已存在或与现有配置冲突" };
  if (postgresCode === "23503") return { status: 409, code: "conflict", message: "资源仍被其他配置引用" };
  if (["22P02", "22001", "23514"].includes(String(postgresCode))) {
    return { status: 400, code: "validation_failed", message: "请求参数不符合数据约束" };
  }
  return null;
}
