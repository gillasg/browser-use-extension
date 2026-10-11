// Host-specific presentation. Each extension that embeds the engine sets these once at startup.
export interface EngineConfig {
  /** Toolbar tooltip while an agent controls a tab. */
  controllingTitle: (owner: string) => string;
  /** Toolbar tooltip once control ends. */
  idleTitle: string;
  /** Extension-relative icon used for hand-off notifications. */
  notificationIcon: string;
}

export const engineConfig: EngineConfig = {
  controllingTitle: () => "An agent is controlling this tab",
  idleTitle: "Browser Use Extension",
  notificationIcon: "icon-128.png",
};

export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(engineConfig, patch);
}
