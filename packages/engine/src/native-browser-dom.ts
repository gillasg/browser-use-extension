import { BrowserActionError } from "./native-browser-common.js";
import { humanType, paceKey } from "./native-browser-human-input.js";

export async function onNode<T>(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
  fn: (...args: never[]) => unknown,
  args: unknown[] = [],
): Promise<T> {
  const resolved = (await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", {
    backendNodeId,
  })) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("STALE_REF");
  try {
    const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error("STALE_REF");
    return result.result?.value as T;
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}

export function nodeState(this: HTMLElement): {
  visible: boolean;
  enabled: boolean;
  editable: boolean;
} {
  const box = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  return {
    visible:
      this.isConnected &&
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none",
    enabled: !this.matches(":disabled,[aria-disabled='true']") && !this.closest("[inert]"),
    editable:
      this.matches("input:not([readonly]),textarea:not([readonly]),select") ||
      this.isContentEditable,
  };
}

export async function visibleNodes(
  debuggee: chrome.debugger.Debuggee,
  ids: number[],
): Promise<number[]> {
  if (ids.length > 100) throw new Error("AMBIGUOUS_TARGET");
  const result: number[] = [];
  for (const id of ids.slice(0, 100)) {
    const state = await onNode<{ visible: boolean }>(debuggee, id, nodeState).catch(
      () => undefined,
    );
    if (state?.visible) result.push(id);
  }
  return result;
}

export async function scopedBackendIds(
  debuggee: chrome.debugger.Debuggee,
  selector: string,
): Promise<Set<number>> {
  const ids = await queryNodes(debuggee, { by: "css", value: selector });
  if (ids.length !== 1) throw new Error(ids.length ? "AMBIGUOUS_TARGET" : "TARGET_NOT_FOUND");
  interface DomNode {
    backendNodeId?: number;
    children?: DomNode[];
    shadowRoots?: DomNode[];
    contentDocument?: DomNode;
  }
  const result = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
    backendNodeId: ids[0],
    depth: -1,
    pierce: true,
  })) as { node?: DomNode };
  const selected = new Set<number>();
  const pending: DomNode[] = result.node ? [result.node] : [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (node.backendNodeId !== undefined) selected.add(node.backendNodeId);
    pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument) pending.push(node.contentDocument);
  }
  return selected;
}

interface Query {
  by: string;
  value: string;
  exact?: boolean | undefined;
  scope?: string | undefined;
}
export async function queryNodes(
  debuggee: chrome.debugger.Debuggee,
  query: Query,
): Promise<number[]> {
  const group = `aeon-query-${crypto.randomUUID()}`;
  try {
    const evaluated = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(${findElements.toString()})(${JSON.stringify(query)})`,
      objectGroup: group,
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    if (evaluated.exceptionDetails) throw new Error("INVALID_TARGET");
    if (!evaluated.result?.objectId) return [];
    return await backendIds(debuggee, evaluated.result.objectId);
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group })
      .catch(() => undefined);
  }
}
async function backendIds(debuggee: chrome.debugger.Debuggee, objectId: string) {
  const properties = (await chrome.debugger.sendCommand(debuggee, "Runtime.getProperties", {
    objectId,
    ownProperties: true,
  })) as { result?: { name: string; value?: { objectId?: string } }[] };
  const ids: number[] = [];
  for (const property of properties.result ?? []) {
    if (!/^\d+$/.test(property.name) || !property.value?.objectId) continue;
    const described = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
      objectId: property.value.objectId,
    })) as { node?: { backendNodeId?: number } };
    if (described.node?.backendNodeId !== undefined) ids.push(described.node.backendNodeId);
  }
  return ids;
}
function findElements(query: Query): Element[] {
  const roots: (Document | ShadowRoot | Element)[] = [document];
  const elements: Element[] = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) continue;
    for (const element of root.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const scopeSelector = query.scope;
  const scopes = scopeSelector ? elements.filter((el) => el.matches(scopeSelector)) : [];
  if (query.scope && scopes.length !== 1) throw Error("Scope must match one element");
  const scopeElement = scopes[0];
  const scoped = scopeElement ? elements.filter((el) => scopeElement.contains(el)) : elements;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const matches = (text: string) =>
    query.exact === false
      ? normalize(text).toLowerCase().includes(normalize(query.value).toLowerCase())
      : normalize(text) === normalize(query.value);
  return scoped.filter((el) => matchElement(el, query, matches)).slice(0, 101);
  function matchElement(el: Element, q: Query, match: (text: string) => boolean): boolean {
    if (q.by === "css") return el.matches(q.value);
    if (q.by === "placeholder") return match(el.getAttribute("placeholder") ?? "");
    if (q.by === "label") {
      const label = labelText(el);
      return Boolean(label) && match(label);
    }
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return (
      match(text) &&
      ![...el.children].some((child) =>
        match((child as HTMLElement).innerText ?? child.textContent ?? ""),
      )
    );
  }
  function labelText(el: Element): string {
    const control = el as HTMLInputElement;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/);
    const labelled = ids
      .map((id) =>
        el.getRootNode() instanceof Document
          ? (document.getElementById(id)?.textContent ?? "")
          : "",
      )
      .join(" ");
    const label =
      el.getAttribute("aria-label") ||
      labelled.trim() ||
      [...(control.labels ?? [])].map((item) => item.textContent).join(" ");

    return label;
  }
}

export async function isFocusedInput(debuggee: chrome.debugger.Debuggee): Promise<boolean> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${focusedInput.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: boolean } };
  return result.result?.value === true;
}
function focusedInput() {
  let active: Element | null = document.activeElement;
  for (let i = 0; i < 20 && active; i++) {
    if (active.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
      continue;
    }
    if (active instanceof HTMLIFrameElement && active.contentDocument?.activeElement) {
      active = active.contentDocument.activeElement;
      continue;
    }
    break;
  }
  return (
    !!active &&
    !active.matches(":disabled,[readonly],[aria-disabled='true']") &&
    (active.matches("input,textarea,select") || (active as HTMLElement).isContentEditable)
  );
}

export async function fillTextNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
): Promise<void> {
  const group = "aeon-fill-" + crypto.randomUUID();
  try {
    const source = (await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", {
      backendNodeId: id,
      objectGroup: group,
    })) as { object?: { objectId?: string } };
    if (!source.object?.objectId) throw new Error("STALE_REF");
    const selected = (await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
      objectId: source.object.objectId,
      functionDeclaration: selectTextInput.toString(),
      objectGroup: group,
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    if (selected.exceptionDetails || !selected.result?.objectId) throw new Error("NOT_EDITABLE");
    const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
      objectId: selected.result.objectId,
    })) as { node?: { backendNodeId?: number } };
    if (!node.node?.backendNodeId) throw new Error("STALE_REF");
    if (value) await humanType(debuggee, value);
    else await clearSelection(debuggee);
    const field = node.node.backendNodeId;
    if (await retained(debuggee, field, value)) return;
    // Rich-text editors (Draft.js, ProseMirror, Lexical, Slate, Quill) can drop or reorder typed
    // characters; the editing command and a paste are what they reliably accept.
    for (const replace of [insertTextCommand, pasteText]) {
      if (!value || !(await onNode<boolean>(debuggee, field, isRichText))) break;
      await onNode(debuggee, field, replace, [value]);
      if (await retained(debuggee, field, value)) return;
    }
    throw new BrowserActionError(
      "INPUT_FAILED",
      "The focused input did not retain the requested value. Inspect it before continuing.",
    );
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group })
      .catch(() => undefined);
  }
}
function selectTextInput(this: HTMLInputElement | HTMLTextAreaElement) {
  if (!editable(this)) return null;
  const root = this.getRootNode() as Document | ShadowRoot;
  this.focus({ preventScroll: true });
  let selected = root.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  while (selected?.shadowRoot?.activeElement)
    selected = selected.shadowRoot.activeElement as HTMLInputElement;
  // Some comboboxes open an overlay and move focus into a replacement input.
  if (!selected || !editable(selected)) return null;
  if (selected.isContentEditable) {
    const selection = selected.ownerDocument.getSelection(),
      range = selected.ownerDocument.createRange();
    range.selectNodeContents(selected);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else selected.select();
  return selected;
  function editable(element: HTMLElement) {
    return (
      element.isConnected &&
      !element.matches(":disabled,[aria-disabled='true'],[readonly]") &&
      (element.matches("input,textarea") || element.isContentEditable)
    );
  }
}
function inputValue(this: HTMLInputElement | HTMLTextAreaElement) {
  return this.isContentEditable ? this.innerText : this.value;
}
/** Editors render spaces as nbsp and add a trailing line break; inputs must match exactly. */
async function retained(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
): Promise<boolean> {
  const actual = await onNode<string>(debuggee, id, inputValue);
  if (actual === value) return true;
  if (!(await onNode<boolean>(debuggee, id, isRichText))) return false;
  const norm = (text: string) =>
    text.replace(/ /g, " ").replace(/\r/g, "").replace(/\n+/g, "\n").trim();
  return norm(actual) === norm(value);
}
function isRichText(this: HTMLElement) {
  return this.isContentEditable;
}
// Both run in the page through onNode, so each selects the editor's contents itself.
function insertTextCommand(this: HTMLElement, text: string) {
  const selection = this.ownerDocument.getSelection(),
    range = this.ownerDocument.createRange();
  this.focus();
  range.selectNodeContents(this);
  selection?.removeAllRanges();
  selection?.addRange(range);
  this.ownerDocument.execCommand("insertText", false, text);
}
function pasteText(this: HTMLElement, text: string) {
  const selection = this.ownerDocument.getSelection(),
    range = this.ownerDocument.createRange();
  this.focus();
  range.selectNodeContents(this);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const data = new DataTransfer();
  data.setData("text/plain", text);
  this.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
}
async function clearSelection(debuggee: chrome.debugger.Debuggee) {
  const event = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
  await paceKey(debuggee);
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    ...event,
    type: "rawKeyDown",
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    ...event,
    type: "keyUp",
  });
}

export function selectorState(selector: string, state: string): boolean {
  const elements = [...document.querySelectorAll(selector)];
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      (box.width > 0 &&
        box.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none") ||
      ((el === document.body || style.display === "contents") &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        [...el.children].some((child) => {
          const rect = child.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }))
    );
  };
  if (state === "attached") return elements.length > 0;
  if (state === "hidden") return elements.every((el) => !visible(el));
  return elements.some(
    (el) =>
      visible(el) &&
      (state !== "editable" ||
        (!el.matches(":disabled,[aria-disabled='true']") &&
          (el.matches("input:not([readonly]),textarea:not([readonly])") ||
            (el as HTMLElement).isContentEditable))),
  );
}
