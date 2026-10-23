// Relevance to a query: BM25 over words, used to rank links (best-first crawling), to keep
// only the relevant parts of a page (fitMarkdown), and to stop adaptive crawls.

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with you your we our not but can".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => word.length > 1 && !STOP.has(word),
  );
}

export class Bm25 {
  private readonly documents: string[][];
  private readonly frequency = new Map<string, number>();
  private readonly average: number;

  constructor(texts: string[]) {
    this.documents = texts.map(tokens);
    for (const words of this.documents)
      for (const word of new Set(words))
        this.frequency.set(word, (this.frequency.get(word) ?? 0) + 1);
    this.average =
      this.documents.reduce((sum, words) => sum + words.length, 0) / (this.documents.length || 1) ||
      1;
  }

  score(index: number, query: string[]): number {
    const words = this.documents[index] ?? [];
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    let total = 0;
    const n = this.documents.length;
    for (const term of query) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const df = this.frequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      total += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (words.length / this.average)));
    }
    return total;
  }
}

/** How well a link (its URL and anchor text) matches the query, 0 to 1. */
export function linkScore(url: string, anchor: string, query: string): number {
  const terms = tokens(query);
  if (!terms.length) return 0;
  const words = new Set(tokens(`${decodeURIComponentSafe(new URL(url).pathname)} ${anchor}`));
  return (
    terms.filter((term) => words.has(term) || [...words].some((word) => word.startsWith(term)))
      .length / terms.length
  );
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text).replace(/[-_/.]+/g, " ");
  } catch {
    return text;
  }
}

/** How well a whole page covers the query, 0 to 1: the share of query terms it contains, weighted by repetition. */
export function pageScore(text: string, query: string): number {
  const terms = tokens(query);
  if (!terms.length) return 0;
  const words = tokens(text);
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const covered = terms.reduce((sum, term) => sum + Math.min(1, (counts.get(term) ?? 0) / 2), 0);
  return covered / terms.length;
}

/** The Markdown blocks relevant to the query (BM25), or, with no query, the blocks with real text. */
export function fitMarkdown(markdown: string, query?: string): string {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!query?.trim())
    return blocks
      .filter((block) => /^#/.test(block) || tokens(block).length >= 8 || /^\|/.test(block))
      .join("\n\n");
  const bm25 = new Bm25(blocks);
  const terms = tokens(query);
  const scores = blocks.map((_, index) => bm25.score(index, terms));
  const best = Math.max(0, ...scores);
  if (!best) return "";
  return blocks
    .filter((block, index) => /^#/.test(block) || (scores[index] ?? 0) >= best * 0.25)
    .join("\n\n");
}

/** Adaptive stopping: the crawl has covered the query when recent pages stop improving on the best. */
export class Saturation {
  private readonly recent: number[] = [];
  private best = 0;

  constructor(
    private readonly window = 10,
    private readonly threshold = 0.9,
  ) {}

  add(score: number): void {
    this.best = Math.max(this.best, score);
    this.recent.push(score);
    if (this.recent.length > this.window) this.recent.shift();
  }

  get saturated(): boolean {
    if (this.best >= this.threshold && this.recent.length >= Math.min(3, this.window)) return true;
    return this.recent.length >= this.window && Math.max(...this.recent) < this.best * 0.5;
  }
}
