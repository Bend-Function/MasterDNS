import { z } from "zod";

const common = {
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
};

const webhookUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Webhook 必须使用 HTTP 或 HTTPS，且不能在 URL 中包含账号密码");

export const createChannelSchema = z.discriminatedUnion("type", [
  z.object({
    ...common,
    type: z.literal("webhook"),
    url: webhookUrl,
    secret: z.string().min(16).max(512),
  }),
  z.object({
    ...common,
    type: z.literal("telegram"),
    botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "Telegram Bot Token 格式不正确"),
    chatId: z.string().trim().min(1).max(128),
  }),
]);

export const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  url: webhookUrl.optional(),
  secret: z.string().min(16).max(512).optional(),
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/).optional(),
  chatId: z.string().trim().min(1).max(128).optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个要修改的字段");

export const linkChannelSchema = z.object({
  eventFilter: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  overridesDefaults: z.boolean().default(false),
});

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
