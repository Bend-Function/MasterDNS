import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ProviderError } from "@masterdns/contracts";
import { ZodError } from "zod";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    if (exception instanceof ZodError) {
      return response.status(HttpStatus.BAD_REQUEST).send({
        error: { code: "validation_failed", message: "请求参数不正确", details: exception.issues },
        requestId: request.id,
      });
    }
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const message = typeof payload === "string"
        ? payload
        : typeof payload === "object" && payload !== null && "message" in payload
          ? String((payload as { message: unknown }).message)
          : exception.message;
      return response.status(exception.getStatus()).send({
        error: { code: httpCode(exception.getStatus()), message },
        requestId: request.id,
      });
    }
    if (exception instanceof ProviderError) {
      const status = providerErrorStatus(exception.code);
      request.log.warn({ provider: exception.provider, code: exception.code }, "Provider request failed");
      return response.status(status).send({
        error: { code: exception.code, message: exception.message },
        requestId: request.id,
      });
    }
    request.log.error({ errorType: exception instanceof Error ? exception.name : typeof exception }, "Unhandled API exception");
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: { code: "internal_error", message: "服务器处理请求时发生错误" },
      requestId: request.id,
    });
  }
}

function providerErrorStatus(code: ProviderError["code"]): number {
  if (code === "authentication_failed") return HttpStatus.UNAUTHORIZED;
  if (code === "permission_denied") return HttpStatus.FORBIDDEN;
  if (code === "not_found") return HttpStatus.NOT_FOUND;
  if (code === "conflict") return HttpStatus.CONFLICT;
  if (code === "validation_failed") return HttpStatus.BAD_REQUEST;
  if (code === "rate_limited") return HttpStatus.TOO_MANY_REQUESTS;
  return HttpStatus.BAD_GATEWAY;
}

function httpCode(status: number): string {
  if (status === 400) return "validation_failed";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "request_failed";
}
