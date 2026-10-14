import { parse } from "acorn";
import { autocompletion } from "@codemirror/autocomplete";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { syntaxTree } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";

// The code editor: highlighting, completion, and checks as you type.

export type Language = "css" | "javascript" | "json";

export interface Editor {
  value: string;
  view: EditorView;
}

const GLOBALS = [
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_listValues",
  "GM_addStyle",
  "GM_addElement",
  "GM_xmlhttpRequest",
  "GM_download",
  "GM_notification",
  "GM_openInTab",
  "GM_registerMenuCommand",
  "GM_setClipboard",
  "GM_getResourceText",
  "GM_getResourceURL",
  "GM_info",
  "GM_log",
  "GM_cookie",
  "unsafeWindow",
  "SB.onElement",
  "SB.waitFor",
  "SB.panel",
  "SB.fetch",
  "SB.api",
  "SB.get",
  "SB.set",
  "SB.notify",
  "SB.companion",
];

function jsLint(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  try {
    parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
    });
    return [];
  } catch (error) {
    const pos = Math.min((error as { pos?: number }).pos ?? 0, text.length);
    return [
      {
        from: pos,
        to: Math.min(pos + 1, text.length),
        severity: "error",
        message: (error as Error).message,
      },
    ];
  }
}

function jsonLint(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const pos = Number(/position (\d+)/.exec((error as Error).message)?.[1] ?? 0);
    return [
      {
        from: Math.min(pos, text.length),
        to: Math.min(pos + 1, text.length),
        severity: "error",
        message: (error as Error).message,
      },
    ];
  }
}

/** CSS: the parser's error nodes. */
function cssLint(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.type.isError && diagnostics.length < 20)
        diagnostics.push({
          from: node.from,
          to: Math.max(node.to, node.from + 1),
          severity: "error",
          message: "CSS syntax error",
        });
    },
  });
  return diagnostics;
}

function language(kind: Language): Extension[] {
  if (kind === "css") return [css(), linter(cssLint)];
  if (kind === "json") return [json(), linter(jsonLint)];
  const completions = javascript().language.data.of({
    autocomplete: (context: {
      matchBefore(re: RegExp): { from: number; text: string } | null;
      explicit: boolean;
    }) => {
      const word = context.matchBefore(/[\w.]+/);
      if (!word || (word.text.length < 2 && !context.explicit)) return null;
      return { from: word.from, options: GLOBALS.map((label) => ({ label, type: "function" })) };
    },
  });
  return [javascript(), completions, linter(jsLint)];
}

export function createEditor(
  parent: HTMLElement,
  kind: Language,
  value: string,
  onChange?: (value: string) => void,
  onSave?: () => void,
): Editor {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        autocompletion(),
        lintGutter(),
        ...language(kind),
        ...(dark ? [oneDark] : []),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (onSave?.(), true) }]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { fontSize: "12.5px", border: "1px solid var(--line)", borderRadius: "8px" },
          ".cm-scroller": {
            fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
            minHeight: "160px",
            maxHeight: "60vh",
          },
        }),
      ],
    }),
  });
  return {
    view,
    get value() {
      return view.state.doc.toString();
    },
    set value(text: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
  };
}
