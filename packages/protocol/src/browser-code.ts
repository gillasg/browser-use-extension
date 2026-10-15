import { z } from "zod";
import { BrowserTargetKeySchema } from "./browser-inventory.js";

// A browser_code cell runs inside the browser executor. Core sends the source once; the
// executor performs browser steps locally and calls back only for workspace and Core services.
export const BrowserCodeRunSchema = z
  .object({
    kind: z.literal("browser.code.run"),
    cellId: z.string().uuid(),
    chatId: z.string().uuid(),
    toolCallId: z.string().min(1).max(256),
    code: z.string().min(1).max(16000),
    targets: z.array(BrowserTargetKeySchema).max(64),
    timeoutMs: z.number().int().min(1000).max(600000),
  })
  .strict();
export type BrowserCodeRun = z.infer<typeof BrowserCodeRunSchema>;

export const BrowserCodeCancelSchema = z
  .object({ kind: z.literal("browser.code.cancel"), cellId: z.string().uuid(), reset: z.boolean() })
  .strict();

/** Executor → Core: a request the browser cannot serve itself (workspace files, upload paths, site scripts). */
export const BrowserCodeCallSchema = z
  .object({
    kind: z.literal("browser.code.call"),
    cellId: z.string().uuid(),
    callId: z.string().min(1).max(64),
    request: z.unknown(),
  })
  .strict();

export const BrowserCodeReplySchema = z
  .object({
    kind: z.literal("browser.code.reply"),
    cellId: z.string().uuid(),
    callId: z.string().min(1).max(64),
    value: z.unknown().optional(),
    error: z.string().max(20000).optional(),
  })
  .strict();

export const BrowserCodeProgressSchema = z
  .object({
    kind: z.literal("browser.code.progress"),
    cellId: z.string().uuid(),
    steps: z.array(z.record(z.string(), z.unknown())).max(256),
    // True while the cell is handed off to the user; the cell deadline is paused meanwhile.
    waitingForUser: z.boolean().optional(),
  })
  .strict();

export const BrowserCodeResultSchema = z
  .object({
    kind: z.literal("browser.code.result"),
    cellId: z.string().uuid(),
    output: z.string().max(1_100_000),
    value: z.unknown().optional(),
    error: z.string().max(20000).optional(),
    reset: z.boolean().optional(),
    steps: z.array(z.record(z.string(), z.unknown())).max(256),
    opened: z.array(BrowserTargetKeySchema).max(64),
  })
  .strict();
export type BrowserCodeResult = z.infer<typeof BrowserCodeResultSchema>;
