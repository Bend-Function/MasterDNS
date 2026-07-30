import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { providerAccounts } from "@masterdns/db";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { createProviderAdapter, type DnsProviderAdapter, type ProviderCredentials } from "@masterdns/providers";
import { DatabaseService } from "../database.service.js";
import { env } from "../env.js";

@Injectable()
export class ProviderRuntimeService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);

  constructor(private readonly database: DatabaseService) {}

  async forAccount(accountId: string): Promise<{ adapter: DnsProviderAdapter; account: typeof providerAccounts.$inferSelect }> {
    const [account] = await this.database.db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId)).limit(1);
    if (!account) throw new Error(`Provider account ${accountId} does not exist`);
    if (account.status !== "active") throw new Error(`Provider account ${accountId} is not active`);
    const credentials = decryptJson<ProviderCredentials>({
      ciphertext: account.credentialCiphertext,
      iv: account.credentialIv,
      tag: account.credentialTag,
      keyVersion: account.credentialKeyVersion,
    }, this.encryptionKey);
    if (credentials.provider !== account.provider) throw new Error("Encrypted credentials do not match provider account type");
    return { adapter: createProviderAdapter(credentials), account };
  }
}
