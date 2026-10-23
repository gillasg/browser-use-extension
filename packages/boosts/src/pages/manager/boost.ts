import { describeHealth } from "../../shared/health.js";
import { diffLines, boostText } from "../../shared/diff.js";
import { boostMatches, describeRule } from "../../shared/match.js";
import { errorText, send } from "../../shared/messages.js";
import { reviewBoost } from "../../shared/review.js";
import type { Boost, Health, Revision, SiteRule } from "../../shared/types.js";
import { createEditor, type Language } from "../editor.js";
import { diffView, download, h, switchInput, toast, when } from "../ui.js";

// One boost: its parts in editors, where it runs, changing it by talking, history, values, health.

interface Loaded {
  boost?: Boost;
  revisions: Revision[];
  health: Health;
  values: Record<string, unknown>;
}

let draft: Boost;
let saved: Boost;
let dirty = false;
let tab = "general";

const RULE_TYPES: SiteRule["type"][] = ["domain", "prefix", "url", "match", "glob", "regex", "all"];

function markDirty(): void {
  dirty = true;
  document.getElementById("save")?.removeAttribute("disabled");
}

async function save(): Promise<void> {
  try {
    saved = await send<Boost>("boost.save", { boost: draft });
    draft = structuredClone(saved);
    dirty = false;
    toast("Saved");
    location.hash = `boost/${saved.id}/${tab}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch (error) {
    toast(errorText(error));
  }
}

function rulesEditor(
  title: string,
  rules: SiteRule[],
  change: (rules: SiteRule[]) => void,
): HTMLElement {
  const box = h("div", { className: "stack" }, h("h3", { textContent: title }));
  const draw = (): void => {
    box.replaceChildren(h("h3", { textContent: title }));
    rules.forEach((rule, index) => {
      const type = h(
        "select",
        {},
        ...RULE_TYPES.map((t) =>
          h("option", { value: t, textContent: t, selected: rule.type === t }),
        ),
      );
      const value = h("input", {
        type: "text",
        value: rule.value ?? "",
        placeholder: "example.com",
        disabled: rule.type === "all",
      });
      const update = (): void => {
        rules[index] = { type: type.value, value: value.value } as SiteRule;
        change(rules);
        markDirty();
      };
      type.onchange = () => {
        update();
        draw();
      };
      value.oninput = update;
      box.append(
        h(
          "div",
          { className: "row" },
          h("div", { style: "width: 110px" }, type),
          value,
          h("button", {
            className: "link danger",
            textContent: "Remove",
            onclick: () => (rules.splice(index, 1), change(rules), markDirty(), draw()),
          }),
        ),
      );
    });
    box.append(
      h("button", {
        textContent: "Add",
        onclick: () => (rules.push({ type: "domain", value: "" }), change(rules), draw()),
      }),
    );
  };
  draw();
  return box;
}

function general(): HTMLElement {
  const name = h("input", { type: "text", value: draft.name });
  name.oninput = () => ((draft.name = name.value), markDirty());
  const description = h("input", {
    type: "text",
    value: draft.description ?? "",
    placeholder: "What it does",
  });
  description.oninput = () => ((draft.description = description.value || undefined), markDirty());
  const tags = h("input", {
    type: "text",
    value: draft.tags.join(", "),
    placeholder: "news, reading",
  });
  tags.oninput = () => (
    (draft.tags = tags.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)),
    markDirty()
  );
  const review = reviewBoost(draft);
  const fromHeader = draft.kind !== "boost";
  return h(
    "div",
    { className: "stack" },
    h("label", { className: "field" }, "Name", name),
    h("label", { className: "field" }, "Description", description),
    h("label", { className: "field" }, "Tags", tags),
    fromHeader
      ? h(
          "div",
          { className: "stack" },
          h("h3", { textContent: "Runs on" }),
          h("div", { textContent: draft.sites.map(describeRule).join(", ") }),
          h("div", { className: "muted", textContent: "Set by the header in the code." }),
        )
      : rulesEditor("Runs on", draft.sites, (rules) => (draft.sites = rules)),
    fromHeader
      ? ""
      : rulesEditor("Except on", (draft.excludes ??= []), (rules) => (draft.excludes = rules)),
    draft.kind === "boost"
      ? h(
          "label",
          { className: "row spread" },
          "Repair automatically when the site changes",
          switchInput(
            draft.autoRepair !== false,
            "Repair automatically",
            (on) => ((draft.autoRepair = on ? undefined : false), markDirty()),
          ),
        )
      : "",
    h(
      "div",
      { className: "card stack" },
      h("h3", { textContent: "What it can do" }),
      ...review.lines.map((line) => h("div", { textContent: line })),
      ...review.warnings.map((line) => h("div", { className: "warn", textContent: line })),
    ),
  );
}

function codeTab(
  label: string,
  language: Language,
  get: () => string | undefined,
  set: (value: string | undefined) => void,
  note?: string,
): HTMLElement {
  const holder = h("div");
  const box = h(
    "div",
    { className: "stack" },
    h("h3", { textContent: label }),
    note ? h("div", { className: "muted", textContent: note }) : "",
    holder,
  );
  createEditor(
    holder,
    language,
    get() ?? "",
    (value) => (set(value.trim() ? value : undefined), markDirty()),
    () => void save(),
  );
  return box;
}

function jsonTab(
  label: string,
  get: () => unknown,
  set: (value: unknown) => void,
  note: string,
): HTMLElement {
  const initial = get();
  return codeTab(
    label,
    "json",
    () => (initial === undefined ? "" : JSON.stringify(initial, null, 2)),
    (text) => {
      try {
        set(text ? JSON.parse(text) : undefined);
      } catch {
        /* the editor shows the error */
      }
    },
    note,
  );
}

function scriptTab(): HTMLElement {
  const world = h(
    "select",
    {},
    h("option", {
      value: "page",
      textContent: "With the page's own data",
      selected: draft.jsWorld !== "isolated",
    }),
    h("option", {
      value: "isolated",
      textContent: "Kept apart from the page",
      selected: draft.jsWorld === "isolated",
    }),
  );
  world.onchange = () => ((draft.jsWorld = world.value as Boost["jsWorld"]), markDirty());
  const runAt = h(
    "select",
    {},
    ...["document-start", "document-body", "document-end", "document-idle", "context-menu"].map(
      (v) =>
        h("option", { value: v, textContent: v, selected: (draft.runAt ?? "document-idle") === v }),
    ),
  );
  runAt.onchange = () => ((draft.runAt = runAt.value as Boost["runAt"]), markDirty());
  return h(
    "div",
    { className: "stack" },
    h(
      "div",
      { className: "row" },
      h("label", { className: "field" }, "Runs", world),
      h("label", { className: "field" }, "When", runAt),
    ),
    codeTab(
      "JavaScript",
      "javascript",
      () => draft.js,
      (v) => (draft.js = v),
      "Helpers: SB.onElement, SB.waitFor, SB.panel, SB.fetch, SB.api, SB.get/set, and the GM_* functions.",
    ),
  );
}

function zapsTab(): HTMLElement {
  const box = h("div", { className: "stack" }, h("h3", { textContent: "Hidden elements" }));
  const zaps = (draft.zaps ??= []);
  if (!zaps.length)
    box.append(
      h("div", {
        className: "muted",
        textContent: "Nothing hidden. Use Zap on the page to add some.",
      }),
    );
  zaps.forEach((zap, index) => {
    const selector = h("input", { type: "text", value: zap.selector });
    selector.oninput = () => ((zap.selector = selector.value), markDirty());
    const contains = h("input", {
      type: "text",
      value: zap.contains ?? "",
      placeholder: "only if it contains…",
    });
    contains.oninput = () => ((zap.contains = contains.value || undefined), markDirty());
    box.append(
      h(
        "div",
        { className: "row" },
        selector,
        contains,
        h("button", {
          className: "link danger",
          textContent: "Show again",
          onclick: () => (zaps.splice(index, 1), markDirty(), box.replaceWith(zapsTab())),
        }),
      ),
    );
  });
  box.append(
    h("button", {
      textContent: "Add",
      onclick: () => (zaps.push({ selector: "" }), box.replaceWith(zapsTab())),
    }),
  );
  return box;
}

function varsTab(): HTMLElement {
  const vars = draft.meta?.vars ?? [];
  const values = (draft.varValues ??= {});
  if (!vars.length)
    return h("div", { className: "muted", textContent: "This style has no settings." });
  return h(
    "div",
    { className: "stack" },
    ...vars.map((v) => {
      const current = values[v.name] ?? v.default;
      const change = (value: string): void => {
        values[v.name] = value;
        markDirty();
      };
      let input: HTMLElement;
      if (v.type === "checkbox")
        input = switchInput(current === "1" || current === "true", v.label, (on) =>
          change(on ? "1" : "0"),
        );
      else if (v.options) {
        const select = h(
          "select",
          {},
          ...v.options.map((o) =>
            h("option", { value: o.name, textContent: o.label, selected: o.name === current }),
          ),
        );
        select.onchange = () => change(select.value);
        input = select;
      } else {
        const field = h("input", {
          type:
            v.type === "color"
              ? "color"
              : v.type === "number" || v.type === "range"
                ? "number"
                : "text",
          value: current,
        });
        if (v.min !== undefined) field.min = String(v.min);
        if (v.max !== undefined) field.max = String(v.max);
        field.oninput = () => change(field.value);
        input = field;
      }
      return h("label", { className: "field" }, v.label, input);
    }),
  );
}

function historyTab(revisions: Revision[]): HTMLElement {
  const box = h("div", { className: "stack" });
  if (!revisions.length)
    box.append(h("div", { className: "muted", textContent: "No history yet." }));
  revisions.forEach((revision, index) => {
    const previous = revisions[index + 1];
    const details = h(
      "details",
      {},
      h("summary", { textContent: "Changes" }),
      diffView(
        diffLines(previous ? boostText(previous.boost) : "", boostText(revision.boost)).filter(
          (line) => line.kind !== " " || revisions.length < 3,
        ),
      ),
    );
    box.append(
      h(
        "div",
        { className: "card stack" },
        h(
          "div",
          { className: "row spread" },
          h(
            "div",
            {},
            h("strong", { textContent: when(revision.at) }),
            " ",
            h("span", { className: "tag", textContent: revision.by }),
            revision.note ? h("div", { className: "muted", textContent: revision.note }) : "",
          ),
          index === 0
            ? h("span", { className: "muted", textContent: "Current" })
            : h("button", {
                textContent: "Restore",
                onclick: () =>
                  void send("boost.rollback", { id: draft.id, at: revision.at }).then(
                    () => (
                      toast("Restored"),
                      window.dispatchEvent(new HashChangeEvent("hashchange"))
                    ),
                  ),
              }),
        ),
        details,
      ),
    );
  });
  return box;
}

function valuesTab(values: Record<string, unknown>): HTMLElement {
  let text = JSON.stringify(values, null, 2);
  const holder = h("div");
  createEditor(holder, "json", text, (value) => (text = value));
  return h(
    "div",
    { className: "stack" },
    h("h3", { textContent: "Stored values" }),
    h("div", {
      className: "muted",
      textContent: "What this boost keeps between visits (GM_setValue, SB.set).",
    }),
    holder,
    h("button", {
      textContent: "Save values",
      onclick: () =>
        void send("values.set", { id: draft.id, values: JSON.parse(text || "{}") }).then(
          () => toast("Values saved"),
          (e: unknown) => toast(errorText(e)),
        ),
    }),
  );
}

async function tabFor(boost: Boost): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.url && boostMatches(boost, t.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

function healthTab(health: Health): HTMLElement {
  const box = h(
    "div",
    { className: "stack" },
    h("div", {
      className: health.status === "broken" ? "warn" : "note",
      textContent: describeHealth(health),
    }),
  );
  if (health.repairError)
    box.append(h("div", { className: "error", textContent: `Last repair: ${health.repairError}` }));
  const last = health.last;
  if (last) {
    box.append(
      h("div", { className: "muted", textContent: `Last visit: ${last.url} · ${when(last.at)}` }),
    );
    box.append(
      h(
        "div",
        { className: "stack" },
        ...last.selectors.map((s) =>
          h(
            "div",
            { className: "row spread" },
            h("code", { textContent: s.selector }),
            h("span", { className: s.count ? "" : "muted", textContent: String(s.count) }),
          ),
        ),
      ),
    );
    for (const error of last.errors)
      box.append(h("div", { className: "error", textContent: error }));
  }
  const repair = async (): Promise<void> => {
    const target = await tabFor(draft);
    if (!target?.id)
      return toast(`Open ${draft.sites.map(describeRule)[0] ?? "the site"} in a tab first`);
    toast("Repairing…");
    await send("repair.run", { id: draft.id, tabId: target.id }).then(
      () => (toast("Repaired"), window.dispatchEvent(new HashChangeEvent("hashchange"))),
      (e: unknown) => toast(errorText(e)),
    );
  };
  box.append(
    h(
      "div",
      { className: "row" },
      h("button", {
        className: "primary",
        textContent: "Repair with AI",
        onclick: () => void repair(),
      }),
      h("button", {
        textContent: "Reset health",
        onclick: () => void send("health.reset", { id: draft.id }).then(() => toast("Reset")),
      }),
    ),
  );
  return box;
}

function talkTab(): HTMLElement {
  const log = h(
    "div",
    { className: "stack" },
    ...(draft.chat ?? []).map((turn) =>
      h("div", { className: turn.role === "user" ? "card" : "note", textContent: turn.text }),
    ),
  );
  const input = h("textarea", {
    placeholder: "Change it, like “also hide the comments” or “make the panel smaller”",
  });
  const result = h("div", { className: "stack" });
  const go = async (): Promise<void> => {
    const target = await tabFor(draft);
    if (!target?.id)
      return void result.replaceChildren(
        h("div", {
          className: "warn",
          textContent: `Open ${draft.sites.map(describeRule)[0] ?? "the site"} in a tab: changes are previewed there.`,
        }),
      );
    const tabId = target.id;
    result.replaceChildren(h("div", { className: "muted", textContent: "Writing…" }));
    try {
      const answer = await send<{ reply: string; boost?: Boost; diff?: string }>("author.run", {
        tabId,
        request: input.value,
        boostId: draft.id,
      });
      result.replaceChildren(h("div", { className: "note", textContent: answer.reply }));
      if (answer.boost) {
        result.append(
          diffView(
            diffLines(boostText(draft), boostText(answer.boost)).filter((l) => l.kind !== " "),
          ),
          h(
            "div",
            { className: "row" },
            h("button", {
              className: "primary",
              textContent: "Keep",
              onclick: () =>
                void send("author.keep", { tabId }).then(() =>
                  window.dispatchEvent(new HashChangeEvent("hashchange")),
                ),
            }),
            h("button", {
              textContent: "Discard",
              onclick: () =>
                void send("author.discard", { tabId }).then(() => result.replaceChildren()),
            }),
            h("span", {
              className: "muted",
              textContent: `Previewing in “${target.title ?? target.url}”`,
            }),
          ),
        );
      }
    } catch (error) {
      result.replaceChildren(h("div", { className: "error", textContent: errorText(error) }));
    }
  };
  return h(
    "div",
    { className: "stack" },
    log,
    input,
    h("button", { className: "primary", textContent: "Change it", onclick: () => void go() }),
    result,
  );
}

function share(): HTMLElement {
  const exportFile = (): void => {
    if (draft.kind === "boost")
      download(
        `${draft.name}.boost.json`,
        JSON.stringify({ ...saved, chat: undefined }, null, 2),
        "application/json",
      );
    else
      download(
        `${draft.name}.user.${draft.kind === "userscript" ? "js" : "css"}`,
        saved.source ?? "",
        "text/plain",
      );
  };
  const copyCode = async (): Promise<void> => {
    await navigator.clipboard.writeText(await send<string>("share.code", { ids: [draft.id] }));
    toast("Share code copied. Anyone with Site Boosts can import it.");
  };
  const remove = async (): Promise<void> => {
    if (!confirm(`Delete “${draft.name}”? Its history goes too.`)) return;
    await send("boost.delete", { id: draft.id });
    location.hash = "";
  };
  return h(
    "div",
    { className: "row", style: "flex-wrap: wrap" },
    h("button", { textContent: "Copy share code", onclick: () => void copyCode() }),
    h("button", { textContent: "Export file", onclick: exportFile }),
    h("button", { className: "danger", textContent: "Delete", onclick: () => void remove() }),
  );
}

function tabsFor(boost: Boost, loaded: Loaded): [string, string, () => HTMLElement][] {
  const common: [string, string, () => HTMLElement][] = [["general", "General", general]];
  if (boost.kind === "userscript")
    common.push([
      "code",
      "Code",
      () =>
        codeTab(
          "Script",
          "javascript",
          () => draft.source,
          (v) => ((draft.source = v), (draft.js = v)),
        ),
    ]);
  else if (boost.kind === "userstyle")
    common.push(
      [
        "code",
        "Code",
        () =>
          codeTab(
            "Style",
            "css",
            () => draft.source,
            (v) => (draft.source = v),
          ),
      ],
      ["vars", "Settings", varsTab],
    );
  else
    common.push(
      ["talk", "Change by talking", talkTab],
      [
        "css",
        "Style",
        () =>
          codeTab(
            "CSS",
            "css",
            () => draft.css,
            (v) => (draft.css = v),
          ),
      ],
      ["zaps", "Hidden", zapsTab],
      [
        "look",
        "Look",
        () =>
          jsonTab(
            "Look",
            () => draft.look,
            (v) => (draft.look = v as Boost["look"]),
            "dark, background, text, link, font, fontScale, brightness, contrast, saturation, maxWidth, hideImages",
          ),
      ],
      [
        "actions",
        "Actions",
        () =>
          jsonTab(
            "Actions",
            () => draft.actions,
            (v) => (draft.actions = v as Boost["actions"]),
            'For example [{"do": "click", "text": "Accept all", "times": 1}]',
          ),
      ],
      [
        "network",
        "Network",
        () =>
          jsonTab(
            "Network rules",
            () => draft.network,
            (v) => (draft.network = v as Boost["network"]),
            'For example [{"action": "block", "domains": ["ads.example"]}]',
          ),
      ],
      [
        "html",
        "HTML",
        () =>
          jsonTab(
            "Added HTML",
            () => draft.html,
            (v) => (draft.html = v as Boost["html"]),
            'For example [{"selector": "h1", "position": "after", "html": "<p>Hi</p>"}]',
          ),
      ],
      ["script", "Script", scriptTab],
    );
  common.push(
    ["history", "History", () => historyTab(loaded.revisions)],
    ["values", "Values", () => valuesTab(loaded.values)],
    ["health", "Health", () => healthTab(loaded.health)],
  );
  return common;
}

export async function renderBoost(
  root: HTMLElement,
  id: string,
  requestedTab?: string,
): Promise<void> {
  const loaded = await send<Loaded>("boost.get", { id });
  if (!loaded.boost) {
    root.replaceChildren(
      h("div", { className: "error", textContent: "This boost no longer exists." }),
      h("a", { href: "#", textContent: "Back to all boosts" }),
    );
    return;
  }
  saved = loaded.boost;
  draft = structuredClone(saved);
  dirty = false;
  const tabs = tabsFor(saved, loaded);
  tab = tabs.some(([key]) => key === requestedTab) ? (requestedTab as string) : "general";
  const body = h("div", { className: "card" });
  const nav = h("nav", { className: "row tabs", style: "flex-wrap: wrap; gap: 4px" });
  const show = (key: string): void => {
    tab = key;
    for (const button of nav.querySelectorAll("button"))
      button.classList.toggle("primary", button.dataset.tab === key);
    body.replaceChildren((tabs.find(([k]) => k === key) ?? tabs[0])?.[2]() ?? "");
    history.replaceState(null, "", `#boost/${id}/${key}`);
  };
  for (const [key, label] of tabs)
    nav.append(
      h("button", { textContent: label, dataset: { tab: key }, onclick: () => show(key) }),
    );
  const saveButton = h("button", {
    id: "save",
    className: "primary",
    textContent: "Save",
    disabled: true,
    onclick: () => void save(),
  });
  root.replaceChildren(
    h("a", { href: "#", textContent: "← All boosts", className: "muted" }),
    h(
      "div",
      { className: "row spread" },
      h(
        "div",
        { className: "row" },
        switchInput(
          saved.enabled,
          "On or off",
          (enabled) =>
            void send("boost.toggle", { id, enabled }).then(() => toast(enabled ? "On" : "Off")),
        ),
        h("h1", { textContent: saved.name }),
      ),
      h("div", { className: "row" }, share(), saveButton),
    ),
    nav,
    body,
  );
  show(tab);
}

export const hasUnsavedChanges = (): boolean => dirty;
