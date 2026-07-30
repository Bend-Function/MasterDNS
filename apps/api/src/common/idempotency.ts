import { z } from "zod";

const idempotencyKeySchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "Idempotency-Key 只能包含可见 ASCII 字符且不能含空格");

export function parseIdempotencyKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : idempotencyKeySchema.parse(value);
}
