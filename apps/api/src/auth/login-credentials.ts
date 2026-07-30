import { verifyPassword } from "@masterdns/crypto";

// Unknown users still pay the normal Argon2 verification cost.
const INVALID_LOGIN_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$YoIWNHEXrbYBsF3GujEhZQ$BEBSfrc8HTCpf38vK1ZXRbpMgIRNriFD/lvFGzBOjm8";

export async function verifyLoginCredentials(passwordHash: string | undefined, password: string): Promise<boolean> {
  const matches = await verifyPassword(passwordHash ?? INVALID_LOGIN_PASSWORD_HASH, password);
  return passwordHash !== undefined && matches;
}
