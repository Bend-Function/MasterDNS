import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { cloudAccounts } from "@masterdns/db";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { CloudError, createCloudAdapter, type AwsCredentials, type CloudAdapter } from "@masterdns/cloud-providers";
import { DatabaseService } from "../database.service.js";
import { env } from "../env.js";

@Injectable()
export class CloudRuntimeService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService) {}

  async adapter(accountId: string, service: "ec2" | "lightsail", options: { observation?: boolean } = {}): Promise<CloudAdapter> {
    const [account] = await this.database.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId)).limit(1);
    if (!account || (!options.observation && !account.enabled)) throw new CloudError("permission_denied", false);
    const credentials = decryptJson<AwsCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.encryptionKey);
    if (credentials.kind !== "access_key" && credentials.kind !== "role") throw new CloudError("invalid_credentials", false);
    const adapter = createCloudAdapter({ accountId, service, credentials });
    const identity = await adapter.verifyIdentity();
    await this.database.db.transaction(async (tx) => {
      const [current] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId)).for("update");
      if (!current || (!options.observation && !current.enabled) || current.credentialCiphertext !== account.credentialCiphertext) throw new CloudError("permission_denied", false);
      if (current.externalAccountId !== null && current.externalAccountId !== identity.externalAccountId) throw new CloudError("remote_identity_changed", false);
      if (current.externalAccountId === null) await tx.update(cloudAccounts).set({ externalAccountId: identity.externalAccountId }).where(eq(cloudAccounts.id, accountId));
    });
    return adapter;
  }
}
