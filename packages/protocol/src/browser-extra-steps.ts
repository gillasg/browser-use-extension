import { z } from "zod";
import { BrowserTargetKeySchema } from "./browser-inventory.js";
import { SiteScriptDefinitionSchema } from "./site-scripts.js";
import { SemanticTargetSchema } from "./browser-elements.js";
const target = BrowserTargetKeySchema;
export const browserExtraSteps = [
  z
    .object({ op: z.literal("evaluate"), target, expression: z.string().min(1).max(20000) })
    .strict(),
  z
    .object({
      op: z.literal("cdp"),
      target,
      method: z
        .string()
        .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
        .max(120),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      op: z.literal("waitFor"),
      target,
      expression: z.string().min(1).max(20000),
      timeoutMs: z.number().int().min(100).max(8000).default(5000),
    })
    .strict(),
  z
    .object({
      op: z.literal("press"),
      target,
      element: SemanticTargetSchema,
      focus: z.boolean().optional(),
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Space",
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("read"),
      target,
      selector: z.string().min(1).max(512),
      limit: z.number().int().min(1).max(100).default(30),
      textLimit: z.number().int().min(1).max(4000).default(1000),
      attributes: z
        .array(z.string().regex(/^[\w-]{1,80}$/))
        .max(10)
        .default([]),
    })
    .strict(),
  z
    .object({
      op: z.literal("wait"),
      target,
      selector: z.string().min(1).max(512),
      state: z.enum(["attached", "visible", "hidden", "editable"]).default("visible"),
      timeoutMs: z.number().int().min(100).max(8000).default(5000),
    })
    .strict(),
  z
    .object({
      op: z.literal("navigate"),
      target,
      url: z
        .string()
        .url()
        .max(8192)
        .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
      /** false for parallel reads: navigate without changing the Split View pair. */
      present: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal("diagnostics"), target, clear: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal("popups"), target }).strict(),
  z
    .object({
      op: z.literal("siteScript"),
      target,
      action: z.enum(["preview", "install", "remove", "status"]),
      definition: SiteScriptDefinitionSchema.optional(),
      scriptId: z.string().uuid().optional(),
    })
    .strict(),
] as const;
