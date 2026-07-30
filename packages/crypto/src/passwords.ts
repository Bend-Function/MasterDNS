import { hash, verify } from "@node-rs/argon2";

const passwordOptions = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("Password must contain at least 12 characters");
  return hash(password, passwordOptions);
}

export function verifyPassword(encoded: string, password: string): Promise<boolean> {
  return verify(encoded, password);
}
