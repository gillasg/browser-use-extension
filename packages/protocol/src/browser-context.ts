import { z } from "zod";
import { BrowserTargetKeySchema } from "./browser-inventory.js";

export const PiBrowserContextRecordSchema = z
  .object({
    contextId: z.string().uuid(),
    kind: z.enum(["page", "selection"]),
    capturedAt: z.string().datetime({ offset: true }),
    target: BrowserTargetKeySchema,
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    title: z.string().max(512).optional(),
    favIconUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:/.test(value))
      .optional(),
    selectedText: z.string().max(8000).optional(),
    selectionTruncated: z.boolean().optional(),
    sourceStatus: z.enum(["current", "stale", "lost", "offline"]).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.kind === "selection" && !record.selectedText?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["selectedText"],
        message: "Selection text is required.",
      });
    }
  });

export type PiBrowserContextRecord = z.infer<typeof PiBrowserContextRecordSchema>;

export const BrowserContextHandoffSchema = z
  .object({
    invocationId: z.string().uuid(),
    windowId: z.number().int().nonnegative(),
    chatId: z.string().uuid().optional(),
    context: PiBrowserContextRecordSchema,
    autoPrompt: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type BrowserContextHandoff = z.infer<typeof BrowserContextHandoffSchema>;

export const BrowserContextDraftSchema = z
  .object({
    invocationId: z.string().uuid(),
    context: PiBrowserContextRecordSchema,
    autoPrompt: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type BrowserContextDraft = z.infer<typeof BrowserContextDraftSchema>;
