// Host-specific presentation. Each extension that embeds the engine sets these once at startup.
export interface EngineConfig {
  /** Toolbar tooltip while an agent controls a tab. */
  controllingTitle: (owner: string) => string;
  /** Toolbar tooltip once control ends. */
  idleTitle: string;
  /** Extension-relative icon used for hand-off notifications. */
  notificationIcon: string;
  /** Whether tabs an agent opens are grouped per session. */
  tabGroups: boolean;
  /** Label of a session's tab group. */
  tabGroupTitle: (owner: string) => string;
  /** How a chat page shows its agent's tabs: Split View beside the chat, or live thumbnails. */
  agentView: () => Promise<"split" | "thumbnails">;
}

export const engineConfig: EngineConfig = {
  controllingTitle: () => "An agent is controlling this tab",
  idleTitle: "Browser Use Extension",
  notificationIcon: "icon-128.png",
  tabGroups: true,
  tabGroupTitle: () => "Agent",
  agentView: () => Promise.resolve("split"),
};

export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(engineConfig, patch);
}
