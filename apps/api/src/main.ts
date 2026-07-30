import "reflect-metadata";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { env } from "./config/env.js";

async function bootstrap() {
  const adapter = new FastifyAdapter({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    },
    trustProxy: env.TRUST_PROXY,
    requestIdHeader: "x-request-id",
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  app.enableCors({ origin: env.WEB_URL, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
