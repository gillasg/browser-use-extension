// The page's HTML with what outerHTML leaves out: the content of open shadow roots (web
// components) and of same-origin iframes, inlined where they appear. Runs in the page.
export function flattenedHtml(): string {
  const VOID = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
  ]);
  const RAW = new Set(["script", "style", "template", "noscript"]);
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const frameBody = (element: Element): HTMLElement | undefined => {
    try {
      return (element as HTMLIFrameElement).contentDocument?.body ?? undefined;
    } catch {
      return undefined;
    }
  };
  const walk = (node: Node, depth: number): string => {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (RAW.has(tag)) return element.outerHTML;
    const attrs = [...element.attributes].map((a) => ` ${a.name}="${attribute(a.value)}"`).join("");
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    let inner = "";
    if (element.shadowRoot && depth < 30)
      inner += [...element.shadowRoot.childNodes].map((child) => walk(child, depth + 1)).join("");
    const frame = tag === "iframe" && depth < 30 ? frameBody(element) : undefined;
    if (frame)
      return `<div data-iframe="${attribute(element.getAttribute("src") ?? "")}">${[...frame.childNodes].map((child) => walk(child, depth + 1)).join("")}</div>`;
    inner += [...element.childNodes].map((child) => walk(child, depth + 1)).join("");
    return `<${tag}${attrs}>${inner}</${tag}>`;
  };
  const needed = [...document.querySelectorAll("*")].some(
    (element) => element.shadowRoot || element.tagName === "IFRAME",
  );
  if (!needed) return document.documentElement.outerHTML;
  return `<!doctype html>${walk(document.documentElement, 0)}`;
}
