import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { ZodType } from "zod";

const validatedBody = createParamDecorator(({ schema }: { schema: ZodType }, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  return schema.parse(request.body);
});

export const ZodBody = (schema: ZodType): ParameterDecorator => {
  // Nest treats objects with a transform method as pipes; Zod schemas have one too.
  return validatedBody({ schema });
};
