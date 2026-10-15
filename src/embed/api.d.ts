// The types of site-boosts/embed for host extensions, so they do not type-check this repo's
// source under their own settings. Keep in line with index.ts.

export declare const MESSAGE_PREFIX = "boosts.";

export type SiteRule = { type: string; value?: string };

export interface BoostEngineOptions {
  /** The content script the host built with site-boosts/embed-build (writeContent). */
  contentScript: string;
}

export interface BoostSummary {
  id: string;
  name: string;
  enabled: boolean;
  sites: SiteRule[];
  parts: string[];
  updated: number;
}

export interface BoostEngine {
  list(url?: string): Promise<BoostSummary[]>;
  get(id: string): Promise<Record<string, unknown> | undefined>;
  /** Saves a boost (new without an id, replaced with one) and applies it in open tabs. */
  save(input: Record<string, unknown>): Promise<BoostSummary>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

export declare function startBoostEngine(options: BoostEngineOptions): BoostEngine;
