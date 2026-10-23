import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { createCloudAdapter, type CloudCredentials } from "@masterdns/cloud-providers";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { cloudAccounts, cloudInstances, resetCloudInstanceState, CloudStateResetError } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { env } from "../../config/env.js";

@Injectable()
export class CloudStateResetService {
  private readonly key = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService) {}

  async reset(actor: AuthUser, instanceId: string) {
    const [before] = await this.database.db.select({ instance: cloudInstances, account: cloudAccounts }).from(cloudInstances)
      .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
      .where(and(eq(cloudInstances.id, instanceId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)));
    if (!before) throw new NotFoundException("Cloud instance not found");
    const { account, instance } = before;
    if (account.provider !== "aws" || !account.enabled || !account.externalAccountId || (account.regions && !account.regions.includes(instance.region))) throw new ConflictException("AWS instance is outside enabled account scope");
    const credentials = decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.key);
    const adapter = createCloudAdapter({ accountId: account.id, provider: account.provider, service: instance.service, credentials });
    try {
      return await resetCloudInstanceState(this.database.db, {
        account, instance, actorUserId: actor.id, source: "user",
        beforeInspect: async () => {
          if ((await adapter.verifyIdentity()).externalAccountId !== account.externalAccountId) throw new ConflictException("Cloud account identity changed");
        },
        inspect: () => adapter.inspect({ accountId: account.id, service: instance.service, region: instance.region, instanceId: instance.externalId }),
      });
    } catch (error) {
      if (error instanceof CloudStateResetError) throw error.statusCode === 400 ? new BadRequestException(error.message) : new ConflictException(error.message);
      throw error;
    }
  }
}
