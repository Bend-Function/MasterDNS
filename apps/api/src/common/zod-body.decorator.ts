import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { ZodType } from "zod";

export const ZodBody = createParamDecorator((schema: ZodType, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  return schema.parse(request.body);
});
