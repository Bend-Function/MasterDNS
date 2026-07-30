import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
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
    request.log.error({ err: exception }, "Unhandled API exception");
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: { code: "internal_error", message: "服务器处理请求时发生错误" },
      requestId: request.id,
    });
  }
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
