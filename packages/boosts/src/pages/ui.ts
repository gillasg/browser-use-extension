import type { DiffLine } from "../shared/diff.js";

// Small DOM helpers shared by the extension's pages.

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "style">
> & { style?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, dataset, ...rest } = props;
  Object.assign(node, rest);
  if (style) node.style.cssText = style;
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of children) if (child !== undefined && child !== false) node.append(child);
  return node;
}

export function switchInput(
  checked: boolean,
  label: string,
  onChange: (on: boolean) => void,
): HTMLInputElement {
  const input = h("input", { type: "checkbox", className: "switch", checked, title: label });
  input.setAttribute("aria-label", label);
  input.onchange = () => onChange(input.checked);
  return input;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string): void {
  document.querySelector(".toast")?.remove();
  const node = h("div", { className: "toast", textContent: text });
  document.body.append(node);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
}

export function diffView(lines: DiffLine[]): HTMLPreElement {
  const pre = h("pre", { className: "diff" });
  for (const line of lines) {
    const span = h(
      "span",
      { className: line.kind === "+" ? "add" : line.kind === "-" ? "remove" : "" },
      `${line.kind} ${line.text}\n`,
    );
    pre.append(span);
  }
  return pre;
}

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const when = (time: number): string =>
  new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
