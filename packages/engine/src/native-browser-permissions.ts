// Site permissions for a tab the agent controls. Chrome's permission prompts (location,
// notifications, camera...) are browser UI that no page or extension can click, so the agent
// decides ahead of time: allowing or blocking the permission for that site means the prompt
// never appears and cannot stall the task.
const TYPES = {
  location: "location",
  notifications: "notifications",
  camera: "camera",
  microphone: "microphone",
  popups: "popups",
  downloads: "automaticDownloads",
} as const;
type PermissionName = keyof typeof TYPES;
const SETTINGS = ["allow", "block", "ask"] as const;

export async function permissionCall(
  tabId: number,
  value: Record<string, unknown>,
): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  const origin = tab.url ? new URL(tab.url).origin : "";
  if (!/^https?:/.test(origin)) throw new Error("INVALID_TARGET: permissions need an http(s) page");
  const name = String(value.type) as PermissionName;
  const type = TYPES[name];
  if (!type) throw new Error("INVALID_PERMISSION: use " + Object.keys(TYPES).join(", "));
  const setting = String(value.setting);
  if (!SETTINGS.includes(setting as (typeof SETTINGS)[number]))
    throw new Error("INVALID_PERMISSION: setting must be allow, block or ask");
  const settings = chrome.contentSettings[type] as chrome.contentSettings.ContentSetting<string>;
  await settings.set({
    primaryPattern: origin + "/*",
    setting,
  });
  return { site: origin, [name]: setting };
}
