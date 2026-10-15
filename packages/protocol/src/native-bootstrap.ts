import { z } from "zod";
import { ProtocolVersionSchema } from "./version.js";

export const NativeSupervisorBootstrapEnvelopeSchema = z
  .object({
    kind: z.literal("supervisor.bootstrap"),
    origin: z.string().max(128),
    requestBase64: z
      .string()
      .max(22_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();

export const NativeBootstrapRequestSchema = z
  .object({
    kind: z.literal("native.bootstrap"),
    protocolVersion: ProtocolVersionSchema,
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
  })
  .strict();
export type NativeBootstrapRequest = z.infer<typeof NativeBootstrapRequestSchema>;

const GrantSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const EndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const endpoint = new URL(value);
      const rawPort = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/aeon\/v1$/.exec(value)?.[1];
      return (
        endpoint.protocol === "ws:" &&
        endpoint.hostname === "127.0.0.1" &&
        endpoint.username === "" &&
        endpoint.password === "" &&
        rawPort !== undefined &&
        Number(rawPort) <= 65535 &&
        endpoint.pathname === "/aeon/v1" &&
        !endpoint.search &&
        !endpoint.hash
      );
    } catch {
      return false;
    }
  });

export const NativeBootstrapResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal("native.bootstrap.result"),
      protocolVersion: ProtocolVersionSchema,
      ok: z.literal(true),
      endpoint: EndpointSchema,
      connectionGrant: GrantSchema,
      expiresAt: z.number().int().positive(),
      daemonProtocolVersion: ProtocolVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("native.bootstrap.result"),
      protocolVersion: ProtocolVersionSchema,
      ok: z.literal(false),
      code: z.enum([
        "INVALID_REQUEST",
        "ORIGIN_NOT_ALLOWED",
        "UPDATE_REQUIRED",
        "DAEMON_OFFLINE",
        "HOST_CONFIG_INVALID",
        "BOOTSTRAP_UNAVAILABLE",
      ]),
      retryable: z.boolean(),
      supportedProtocolVersion: ProtocolVersionSchema,
    })
    .strict(),
]);
export type NativeBootstrapResponse = z.infer<typeof NativeBootstrapResponseSchema>;

export const AuthHelloSchema = z
  .object({
    kind: z.literal("auth.hello"),
    protocolVersion: ProtocolVersionSchema,
    role: z.enum(["extension-executor", "ui"]),
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
    pageInstanceId: z.string().uuid().optional(),
    connectionGrant: GrantSchema,
  })
  .strict()
  .superRefine((hello, context) => {
    if (hello.role === "ui" && !hello.pageInstanceId)
      context.addIssue({ code: "custom", message: "UI hello requires a page instance ID." });
    if (hello.role === "extension-executor" && hello.pageInstanceId)
      context.addIssue({ code: "custom", message: "Executor hello cannot name a UI page." });
  });
export type AuthHello = z.infer<typeof AuthHelloSchema>;

export const AuthReplySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("auth.ready"),
      protocolVersion: ProtocolVersionSchema,
      role: z.enum(["extension-executor", "ui"]),
      connectionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("auth.rejected"),
      protocolVersion: ProtocolVersionSchema,
      code: z.enum([
        "MALFORMED_HELLO",
        "UPDATE_REQUIRED",
        "ORIGIN_NOT_ALLOWED",
        "AUTHENTICATION_FAILED",
        "GRANT_EXPIRED",
        "ROLE_NOT_ALLOWED",
        "SCOPE_MISMATCH",
      ]),
    })
    .strict(),
]);
export type AuthReply = z.infer<typeof AuthReplySchema>;

export const PageGrantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog") }).strict(),
  z.object({ kind: z.literal("management") }).strict(),
  z.object({ kind: z.literal("chat"), chatId: z.string().uuid() }).strict(),
]);
export type PageGrantScope = z.infer<typeof PageGrantScopeSchema>;

export const PageGrantIssueRequestSchema = z
  .object({
    kind: z.literal("grant.page.issue"),
    requestId: z.string().uuid(),
    pageInstanceId: z.string().uuid(),
    scope: PageGrantScopeSchema,
  })
  .strict();
export type PageGrantIssueRequest = z.infer<typeof PageGrantIssueRequestSchema>;

export const PageGrantIssueResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal("grant.page.result"),
      requestId: z.string().uuid(),
      ok: z.literal(true),
      pageInstanceId: z.string().uuid(),
      scope: PageGrantScopeSchema,
      connectionGrant: GrantSchema,
      expiresAt: z.number().int().positive(),
      endpoint: EndpointSchema,
      protocolVersion: ProtocolVersionSchema,
      clientInstanceId: z.string().uuid(),
      browserRunId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("grant.page.result"),
      requestId: z.string().uuid(),
      ok: z.literal(false),
      code: z.enum(["INVALID_SCOPE", "DAEMON_OFFLINE", "UPDATE_REQUIRED"]),
    })
    .strict(),
]);
export type PageGrantIssueResponse = z.infer<typeof PageGrantIssueResponseSchema>;
