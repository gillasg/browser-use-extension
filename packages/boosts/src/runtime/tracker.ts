import type { Transport } from "./transport.js";

// What a script did on this page (elements it found, errors it hit), sent once things settle so
// the extension can tell when a site change broke it.

export class Tracker {
  private counts = new Map<string, number>();
  private samples = new Map<string, Element>();
  private errors: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private transport: Transport) {
    this.schedule();
  }

  watch(selector: string): void {
    if (!this.counts.has(selector)) this.counts.set(selector, 0);
    this.schedule();
  }

  found(selector: string, element: Element): void {
    this.counts.set(selector, (this.counts.get(selector) ?? 0) + 1);
    if (!this.samples.has(selector)) this.samples.set(selector, element);
  }

  error(message: string): void {
    if (this.errors.length < 10) this.errors.push(message);
    this.schedule();
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.send(), 4000);
  }

  private send(): void {
    this.timer = undefined;
    const selectors = [...this.counts].map(([selector, count]) => ({
      selector,
      count,
      sample: sample(this.samples.get(selector)),
    }));
    void this.transport
      .call("health", { selectors, errors: this.errors.splice(0) })
      .catch(() => undefined);
  }
}

function sample(
  element: Element | undefined,
): { tag: string; text?: string; attrs?: Record<string, string> } | undefined {
  if (!element) return undefined;
  const attrs: Record<string, string> = {};
  for (const attr of element.attributes)
    if (attr.value.length < 80 && !attr.name.startsWith("on")) attrs[attr.name] = attr.value;
  return {
    tag: element.tagName.toLowerCase(),
    text: element.textContent?.trim().slice(0, 80),
    attrs,
  };
}
