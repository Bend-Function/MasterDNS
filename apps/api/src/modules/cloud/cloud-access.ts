import { ForbiddenException } from "@nestjs/common";
import type { AuthUser } from "../../auth/auth.types.js";

export function assertCloudAccess(actor: AuthUser, ownerId: string): void {
  if (actor.role !== "admin" && actor.id !== ownerId) {
    throw new ForbiddenException("Cloud resource access denied");
  }
}
