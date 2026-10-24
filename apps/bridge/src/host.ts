import type { ModelLike } from "@browserkit/tools/site-to-api";

// What the commands need from the app that runs them. browserkit's own command line supplies
// nothing: the bridge is its browser and a standalone CLI has no model. A host that runs browser
// code itself (an app with its own browser connection and its own model) supplies both, and the
// same commands then work there without a second copy.

export interface CliHost {
  /** Runs browser code in a named session; the last expression is returned. */
  runInBrowser(code: string, options?: { session?: string; timeoutMs?: number }): Promise<unknown>;
  /** The model the AI commands use (describe, edit, name, find, explore), when the host has one. */
  model?(): Promise<ModelLike | undefined>;
}

let host: CliHost | undefined;

/** Installs (or, with undefined, removes) the host the commands run in. */
export function configureCliHost(next: CliHost | undefined): void {
  host = next;
}

export function cliHost(): CliHost | undefined {
  return host;
}

/** The host's model, or undefined so the command says plainly that it needs one. */
export async function cliModel(): Promise<ModelLike | undefined> {
  return host?.model?.();
}
