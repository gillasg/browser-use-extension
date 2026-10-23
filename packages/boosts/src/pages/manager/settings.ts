import { errorText, send } from "../../shared/messages.js";
import type { ModelSettings, ProviderId, Settings } from "../../shared/types.js";
import { download, fromBase64, h, switchInput, toast, toBase64, when } from "../ui.js";

// Settings: the model, the companion extension, site-to-api, repair, updates, the blocklist,
// backups, sharing and WebDAV sync.

interface Status {
  userScripts: boolean;
  version: string;
  companion?: { id: string; name: string; features: string[] };
}

type Providers = Record<
  Exclude<ProviderId, "companion">,
  { label: string; keyUrl: string; defaultModel: string; base: string }
>;

let settings: Settings;

const saveSettings = async (patch: Partial<Settings>, message = "Saved"): Promise<void> => {
  settings = await send<Settings>("settings.set", { patch });
  toast(message);
};

function providerSelect(
  providers: Providers,
  status: Status,
  model: ModelSettings,
): HTMLSelectElement {
  return h(
    "select",
    {},
    ...Object.entries(providers).map(([id, p]) =>
      h("option", { value: id, textContent: p.label, selected: model.provider === id }),
    ),
    h("option", {
      value: "companion",
      textContent: status.companion
        ? `${status.companion.name} (its own sign-in)`
        : "A companion extension (none found)",
      selected: model.provider === "companion",
      disabled: !status.companion,
    }),
  );
}

function modelButtons(current: () => ModelSettings): HTMLElement {
  return h(
    "div",
    { className: "row" },
    h("button", {
      className: "primary",
      textContent: "Save",
      onclick: () => void saveSettings({ model: current() }, "Model saved"),
    }),
    settings.model
      ? h("button", {
          textContent: "Disconnect",
          onclick: () =>
            void saveSettings({ model: undefined }, "Disconnected").then(() => location.reload()),
        })
      : "",
  );
}

function modelSection(providers: Providers, status: Status): HTMLElement {
  const model: ModelSettings = settings.model ?? {
    provider: status.companion ? "companion" : "anthropic",
    model: providers.anthropic.defaultModel,
  };
  const provider = providerSelect(providers, status, model);
  const key = h("input", {
    type: "password",
    value: model.apiKey ?? "",
    placeholder: "API key",
    autocomplete: "off",
  });
  const base = h("input", {
    type: "url",
    value: model.baseUrl ?? "",
    placeholder: "http://localhost:11434/v1",
  });
  const name = h("input", { type: "text", value: model.model, placeholder: "Model name" });
  const list = h("datalist", { id: "models" });
  name.setAttribute("list", "models");
  const keyLink = h("a", { target: "_blank", textContent: "Get a key" });
  const current = (): ModelSettings => ({
    provider: provider.value as ProviderId,
    apiKey: key.value.trim() || undefined,
    baseUrl: base.value.trim() || undefined,
    model: name.value.trim(),
  });
  const sync = (): void => {
    const p = provider.value as ProviderId;
    const info = p === "companion" ? undefined : providers[p];
    keyLink.href = info?.keyUrl ?? "";
    keyLink.hidden = !info?.keyUrl;
    key.parentElement?.toggleAttribute("hidden", p === "companion");
    base.parentElement?.toggleAttribute("hidden", p !== "custom");
    name.parentElement?.toggleAttribute("hidden", p === "companion");
    if (!name.value && info?.defaultModel) name.value = info.defaultModel;
  };
  provider.onchange = () => {
    name.value = "";
    sync();
  };
  const load = async (): Promise<void> => {
    try {
      const models = await send<string[]>("models.list", { model: current() });
      list.replaceChildren(...models.map((m) => h("option", { value: m })));
      toast(`${models.length} models`);
    } catch (error) {
      toast(errorText(error));
    }
  };
  const box = h(
    "section",
    { className: "card stack" },
    h("h2", { textContent: "Model" }),
    h("div", {
      className: "muted",
      textContent:
        "Used only to write and repair boosts. Your key stays in this browser and is sent only to the provider.",
    }),
    h("label", { className: "field" }, "Provider", provider),
    h("label", { className: "field" }, h("span", {}, "API key ", keyLink), key),
    h("label", { className: "field" }, "Address", base),
    h(
      "label",
      { className: "field" },
      "Model",
      h(
        "div",
        { className: "row" },
        name,
        h("button", { textContent: "Load list", onclick: () => void load() }),
      ),
      list,
    ),
    modelButtons(current),
  );
  queueMicrotask(sync);
  return box;
}

function siteMapperSection(): HTMLElement {
  const url = h("input", {
    type: "url",
    value: settings.siteMapper?.url ?? "",
    placeholder: "http://127.0.0.1:4100",
  });
  const token = h("input", {
    type: "password",
    value: settings.siteMapper?.token ?? "",
    placeholder: "The token site-to-api serve prints",
  });
  return h(
    "section",
    { className: "card stack" },
    h("h2", { textContent: "Site APIs" }),
    h("div", {
      className: "muted",
      textContent:
        "Connect a site-to-api server (site-to-api serve) and boosts can use the APIs of sites you mapped: price history, the same product elsewhere, your own data.",
    }),
    h("label", { className: "field" }, "Server", url),
    h("label", { className: "field" }, "Token", token),
    h("button", {
      className: "primary",
      textContent: "Save",
      onclick: () =>
        void saveSettings({
          siteMapper: url.value ? { url: url.value.trim(), token: token.value.trim() } : undefined,
        }),
    }),
  );
}

function behaviourSection(): HTMLElement {
  const blocklist = h("textarea", {
    value: settings.blocklist.join("\n"),
    placeholder: "bank.example.com\nhttps://mail.example.com/*",
  });
  const hours = h("input", { type: "number", min: "1", value: String(settings.updates.hours) });
  const apply = h(
    "select",
    {},
    h("option", {
      value: "auto",
      textContent: "Install updates automatically",
      selected: settings.updates.apply === "auto",
    }),
    h("option", {
      value: "ask",
      textContent: "Only tell me",
      selected: settings.updates.apply === "ask",
    }),
  );
  return h(
    "section",
    { className: "card stack" },
    h("h2", { textContent: "Behaviour" }),
    h(
      "label",
      { className: "row spread" },
      "Repair boosts automatically when a site changes",
      switchInput(
        settings.autoRepair,
        "Automatic repair",
        (on) => void saveSettings({ autoRepair: on }),
      ),
    ),
    h(
      "label",
      { className: "row spread" },
      "Show the ⚡ button on pages with boosts",
      switchInput(
        settings.showChip,
        "Show the button",
        (on) => void saveSettings({ showChip: on }),
      ),
    ),
    h(
      "label",
      { className: "row spread" },
      "Check scripts and styles for updates",
      switchInput(
        settings.updates.enabled,
        "Updates",
        (on) => void saveSettings({ updates: { ...settings.updates, enabled: on } }),
      ),
    ),
    h(
      "div",
      { className: "row" },
      h("label", { className: "field" }, "Every (hours)", hours),
      h("label", { className: "field" }, "Then", apply),
      h("button", {
        textContent: "Save",
        onclick: () =>
          void saveSettings({
            updates: {
              ...settings.updates,
              hours: Math.max(1, Number(hours.value) || 24),
              apply: apply.value as "auto" | "ask",
            },
          }),
      }),
    ),
    h(
      "label",
      { className: "field" },
      "Never run anything on (one site or pattern per line)",
      blocklist,
    ),
    h("button", {
      textContent: "Save the list",
      onclick: () =>
        void saveSettings({
          blocklist: blocklist.value
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        }),
    }),
  );
}

async function importFile(file: File): Promise<void> {
  const result = await (file.name.endsWith(".zip")
    ? send<{ added: number; updated: number; skipped: number }>("backup.import", {
        zip: toBase64(new Uint8Array(await file.arrayBuffer())),
      })
    : send<{ added: number; updated: number; skipped: number }>("backup.import", {
        text: await file.text(),
      }));
  toast(`Added ${result.added}, updated ${result.updated}, unchanged ${result.skipped}`);
}

function backupSection(): HTMLElement {
  const file = h("input", { type: "file", accept: ".json,.zip,.js,.css" });
  file.onchange = () => {
    const chosen = file.files?.[0];
    if (chosen) void importFile(chosen).catch((e: unknown) => toast(errorText(e)));
  };
  const code = h("textarea", {
    placeholder: "Paste a share code (site-boosts:…), a boost's JSON, or a userscript",
  });
  const dav = settings.webdav ?? { url: "" };
  const davUrl = h("input", {
    type: "url",
    value: dav.url,
    placeholder: "https://cloud.example.com/remote.php/dav/files/me/boosts/",
  });
  const davUser = h("input", { type: "text", value: dav.user ?? "", placeholder: "User" });
  const davPassword = h("input", {
    type: "password",
    value: dav.password ?? "",
    placeholder: "Password or app password",
  });
  const sync = async (): Promise<void> => {
    await saveSettings(
      {
        webdav: {
          url: davUrl.value.trim(),
          user: davUser.value || undefined,
          password: davPassword.value || undefined,
          lastSync: dav.lastSync,
        },
      },
      "Syncing…",
    );
    const result = await send<{ added: number; updated: number; uploaded: number }>("webdav.sync");
    toast(`Synced: ${result.added} new, ${result.updated} updated, ${result.uploaded} uploaded`);
  };
  return h(
    "section",
    { className: "card stack" },
    h("h2", { textContent: "Backup and sharing" }),
    h(
      "div",
      { className: "row", style: "flex-wrap: wrap" },
      h("button", {
        textContent: "Export everything (JSON)",
        onclick: () =>
          void send<string>("backup.export", { format: "json" }).then((text) =>
            download(
              `site-boosts-${new Date().toISOString().slice(0, 10)}.json`,
              text,
              "application/json",
            ),
          ),
      }),
      h("button", {
        textContent: "Export everything (ZIP)",
        onclick: () =>
          void send<string>("backup.export", { format: "zip" }).then((b64) =>
            download(
              `site-boosts-${new Date().toISOString().slice(0, 10)}.zip`,
              fromBase64(b64),
              "application/zip",
            ),
          ),
      }),
    ),
    h("label", { className: "field" }, "Import a backup, a ZIP, or .user.js/.user.css files", file),
    h("label", { className: "field" }, "Import from text", code),
    h("button", {
      textContent: "Import",
      onclick: () =>
        void send<{ added: number }>("backup.import", { text: code.value }).then(
          (r) => toast(`Added ${r.added}`),
          (e: unknown) => toast(errorText(e)),
        ),
    }),
    h("h3", { textContent: "Sync through WebDAV" }),
    h("div", {
      className: "muted",
      textContent: dav.lastSync
        ? `Last synced ${when(dav.lastSync)}`
        : "Keeps boosts the same on every computer, through any WebDAV folder (Nextcloud, ownCloud, a NAS).",
    }),
    davUrl,
    h("div", { className: "row" }, davUser, davPassword),
    h("button", {
      textContent: "Sync now",
      onclick: () => void sync().catch((e: unknown) => toast(errorText(e))),
    }),
  );
}

export async function renderSettings(root: HTMLElement): Promise<void> {
  const [loaded, providers, status] = await Promise.all([
    send<Settings>("settings.get"),
    send<Providers>("providers"),
    send<Status>("status"),
  ]);
  settings = loaded;
  root.replaceChildren(
    h("h1", { textContent: "Settings" }),
    status.userScripts
      ? ""
      : h(
          "div",
          { className: "warn" },
          "Boosts with JavaScript need “Allow User Scripts”. ",
          h("a", { href: "setup.html", textContent: "Set it up" }),
        ),
    modelSection(providers, status),
    siteMapperSection(),
    behaviourSection(),
    backupSection(),
    h("div", {
      className: "muted",
      textContent: `Site Boosts ${status.version}${status.companion ? ` · Companion: ${status.companion.name}` : ""}`,
    }),
  );
}
