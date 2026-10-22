// Engine modules register their Chrome listeners here instead of at import, so importing a
// module (in a test, or a page that only needs a helper) never touches `chrome`. The service
// worker calls installEngineListeners() once, synchronously at load, as MV3 requires.

const installers: Array<() => void> = [];
let installed = false;

/** Runs `install` when the worker installs the engine (at once if it already has). */
export function onEngineInstall(install: () => void): void {
  installers.push(install);
  if (installed) install();
}

/**
 * Registers every engine listener. Call at the top level of the service worker. One that throws
 * (say, an API the manifest lacks permission for) doesn't stop the rest; the errors are thrown
 * together at the end so the worker's log and the permissions check still see them.
 */
export function installEngineListeners(): void {
  if (installed) return;
  installed = true;
  const errors: unknown[] = [];
  for (const install of installers) {
    try {
      install();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Some engine listeners failed to install");
}
