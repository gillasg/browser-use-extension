// The URL frontier: what to fetch next. Breadth-first, depth-first, or best-first by a score.

export interface FrontierItem {
  url: string;
  depth: number;
  score: number;
  /** Sitemap lastmod, used to skip pages unchanged since a date. */
  lastmod?: string;
  parent?: string;
}

export class Frontier {
  private items: FrontierItem[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly strategy: "bfs" | "dfs" | "best" = "bfs") {}

  /** Adds a URL once; returns whether it was new. */
  push(item: FrontierItem): boolean {
    if (this.seen.has(item.url)) return false;
    this.seen.add(item.url);
    if (this.strategy === "best") {
      const index = this.items.findIndex((other) => other.score < item.score);
      if (index < 0) this.items.push(item);
      else this.items.splice(index, 0, item);
    } else this.items.push(item);
    return true;
  }

  next(): FrontierItem | undefined {
    return this.strategy === "dfs" ? this.items.pop() : this.items.shift();
  }

  has(url: string): boolean {
    return this.seen.has(url);
  }

  /** Marks a URL as known without queuing it (already done in an earlier run). */
  markSeen(url: string): void {
    this.seen.add(url);
  }

  get size(): number {
    return this.items.length;
  }

  snapshot(): { items: FrontierItem[]; seen: string[] } {
    return { items: [...this.items], seen: [...this.seen] };
  }

  restore(state: { items: FrontierItem[]; seen: string[] }): void {
    this.items = [...state.items];
    for (const url of state.seen) this.seen.add(url);
  }
}
