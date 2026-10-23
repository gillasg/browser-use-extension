import type { ModelMessage } from "../shared/ai.js";
import type { ModelSettings, ProviderId } from "../shared/types.js";
import { companionComplete } from "./integrations.js";

// Model providers, called straight from the extension with the person's own key, or through a
// companion extension's sign-in.

export const PROVIDERS: Record<
  Exclude<ProviderId, "companion">,
  { label: string; base: string; keyUrl: string; defaultModel: string }
> = {
  anthropic: {
    label: "Anthropic",
    base: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5-5",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "",
  },
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    defaultModel: "",
  },
  custom: {
    label: "Local or OpenAI-compatible",
    base: "http://localhost:11434/v1",
    keyUrl: "",
    defaultModel: "",
  },
};

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = data.error as { message?: string } | string | undefined;
    throw new Error(
      `The model answered ${response.status}: ${typeof error === "string" ? error : (error?.message ?? response.statusText)}`,
    );
  }
  return data;
}

async function anthropic(
  settings: ModelSettings,
  system: string,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const data = await postJson(
    `${PROVIDERS.anthropic.base}/messages`,
    {
      "x-api-key": settings.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    { model: settings.model, max_tokens: 8000, system, messages },
    signal,
  );
  return ((data.content as { type: string; text?: string }[] | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

function openAiBase(settings: ModelSettings): string {
  if (settings.provider === "custom")
    return (settings.baseUrl || PROVIDERS.custom.base).replace(/\/+$/, "");
  return PROVIDERS[settings.provider as "openai" | "openrouter"].base;
}

async function openAiCompatible(
  settings: ModelSettings,
  system: string,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = settings.apiKey
    ? { authorization: `Bearer ${settings.apiKey}` }
    : {};
  if (settings.provider === "openrouter") headers["x-title"] = "Site Boosts";
  const data = await postJson(
    `${openAiBase(settings)}/chat/completions`,
    headers,
    { model: settings.model, messages: [{ role: "system", content: system }, ...messages] },
    signal,
  );
  const choice = (data.choices as { message?: { content?: string } }[] | undefined)?.[0];
  return choice?.message?.content ?? "";
}

async function gemini(
  settings: ModelSettings,
  system: string,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const data = await postJson(
    `${PROVIDERS.gemini.base}/models/${encodeURIComponent(settings.model)}:generateContent`,
    { "x-goog-api-key": settings.apiKey ?? "" },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    },
    signal,
  );
  const candidate = (
    data.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined
  )?.[0];
  return (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

export async function complete(
  settings: ModelSettings | undefined,
  system: string,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!settings) throw new Error("Connect a model in Site Boosts settings to write boosts");
  if (settings.provider === "companion") return companionComplete(system, messages);
  if (!settings.model) throw new Error("Choose a model in Site Boosts settings");
  if (settings.provider === "anthropic") return anthropic(settings, system, messages, signal);
  if (settings.provider === "gemini") return gemini(settings, system, messages, signal);
  return openAiCompatible(settings, system, messages, signal);
}

/** The provider's model list, for the settings page. */
export async function listModels(settings: ModelSettings): Promise<string[]> {
  if (settings.provider === "companion") return [];
  if (settings.provider === "gemini") {
    const response = await fetch(`${PROVIDERS.gemini.base}/models?pageSize=200`, {
      headers: { "x-goog-api-key": settings.apiKey ?? "" },
    });
    const data = (await response.json()) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[];
    };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
  }
  const base = settings.provider === "anthropic" ? PROVIDERS.anthropic.base : openAiBase(settings);
  const headers: Record<string, string> =
    settings.provider === "anthropic"
      ? {
          "x-api-key": settings.apiKey ?? "",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        }
      : settings.apiKey
        ? { authorization: `Bearer ${settings.apiKey}` }
        : {};
  const response = await fetch(`${base}/models`, { headers });
  if (!response.ok) throw new Error(`Could not list models (${response.status}). Check the key.`);
  const data = (await response.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id).sort();
}
