import { z } from "zod";
import { BrowserTargetKeySchema, BrowserTabSchema } from "./browser-inventory.js";

export const SiteScriptDefinitionSchema = z
  .object({
    scriptId: z.string().uuid(),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    matches: z
      .array(
        z
          .string()
          .max(2048)
          .regex(/^https?:\/\/[^/*]+\/.*$/),
      )
      .min(1)
      .max(10),
    code: z.string().max(32000),
    css: z.string().max(16000),
    enabled: z.boolean(),
  })
  .strict();
export type SiteScriptDefinition = z.infer<typeof SiteScriptDefinitionSchema>;

export const SiteScriptCommandSchema = z
  .object({
    action: z.enum([
      "list",
      "get",
      "status",
      "preview",
      "save",
      "update",
      "enable",
      "disable",
      "delete",
      "undo",
    ]),
    target: BrowserTargetKeySchema.optional(),
    scriptId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    matches: SiteScriptDefinitionSchema.shape.matches.optional(),
    code: z.string().max(32000).optional(),
    css: z.string().max(16000).optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
export type SiteScriptCommand = z.infer<typeof SiteScriptCommandSchema>;

export const BrowserScriptsSyncSchema = z
  .object({
    kind: z.literal("browser.scripts.sync"),
    scripts: z.array(SiteScriptDefinitionSchema).max(100),
  })
  .strict();
export const BrowserPopupSchema = z
  .object({
    kind: z.literal("browser.popup"),
    chatId: z.string().uuid(),
    opener: BrowserTargetKeySchema,
    tab: BrowserTabSchema,
  })
  .strict();
