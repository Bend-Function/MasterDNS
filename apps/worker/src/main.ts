import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module.js";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ["error", "warn", "log"] });
  app.enableShutdownHooks();
}

void bootstrap();
