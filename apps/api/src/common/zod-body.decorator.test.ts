import "reflect-metadata";
import { Controller, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCloudAccountSchema, type CreateCloudAccountInput } from "../modules/cloud/cloud.schemas.js";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { ZodBody } from "./zod-body.decorator.js";

class BodyController {
  account(input: CreateCloudAccountInput) {
    return { name: input.name, provider: input.provider, kind: input.credentials.kind, regions: input.regions };
  }
  normalized(input: { name: string; enabled: boolean }) { return input; }
}

// Register through Nest's real decorator machinery, including parameter classification.
Controller()(BodyController);
Post("cloud-accounts")(BodyController.prototype, "account", Object.getOwnPropertyDescriptor(BodyController.prototype, "account")!);
ZodBody(createCloudAccountSchema)(BodyController.prototype, "account", 0);
Post("normalized")(BodyController.prototype, "normalized", Object.getOwnPropertyDescriptor(BodyController.prototype, "normalized")!);
ZodBody(z.object({ name: z.string().trim().transform(value => value.toUpperCase()), enabled: z.boolean().default(true) }))(BodyController.prototype, "normalized", 0);
class BodyModule {}
Module({ controllers: [BodyController] })(BodyModule);

describe("ZodBody HTTP validation", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(BodyModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app?.close(); });

  it("accepts AWS account input without treating the Zod schema as a Nest pipe", async () => {
    const response = await app.inject({ method: "POST", url: "/cloud-accounts", payload: {
      name: " Tokyo ", provider: "aws", regions: ["ap-northeast-1"],
      credentials: { kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" },
    } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ name: "Tokyo", provider: "aws", kind: "access_key", regions: ["ap-northeast-1"] });
  });

  it("returns validation errors instead of 500 for invalid account input", async () => {
    const response = await app.inject({ method: "POST", url: "/cloud-accounts", payload: { name: "Tokyo", provider: "aws" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "validation_failed", details: [expect.objectContaining({ path: ["credentials"] })] } });
  });

  it("passes parsed transforms and defaults to the handler", async () => {
    const response = await app.inject({ method: "POST", url: "/normalized", payload: { name: " tokyo " } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ name: "TOKYO", enabled: true });
  });
});
