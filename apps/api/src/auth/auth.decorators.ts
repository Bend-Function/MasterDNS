import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AuthUser } from "./auth.types.js";

export const PUBLIC_ROUTE = "masterdns:public";
export const NON_BROWSER_ROUTE = "masterdns:non-browser";

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const AllowNonBrowser = () => SetMetadata(NON_BROWSER_ROUTE, true);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return (context.switchToHttp().getRequest<FastifyRequest>() as FastifyRequest & { currentUser: AuthUser }).currentUser;
});
