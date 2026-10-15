import { z } from "zod";

export const ProtocolVersionSchema = z
  .object({
    major: z.number().int().positive(),
    minor: z.number().int().nonnegative(),
  })
  .strict();
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

/** The version of these messages; apps that build on them keep their own version. */
export const ENGINE_PROTOCOL_VERSION = { major: 1, minor: 7 } as const;
