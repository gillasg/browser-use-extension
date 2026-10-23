import { withBrowserDebugger } from "./native-browser-session.js";

// The page side of a password-manager sign-in: find the sign-in fields, type into them as real
// keystrokes (sites that ignore scripted values still see them), and press the form's button.

export interface SignInFields {
  user: boolean;
  userValue: string;
  password: boolean;
  code: boolean;
  submit: boolean;
  captcha: boolean;
  url: string;
}

const MARK = "data-signin-field";

/** Marks the visible username, password, one-time-code field and submit button. */
const SCAN = `(() => {
  const mark = ${JSON.stringify(MARK)};
  document.querySelectorAll("[" + mark + "]").forEach((el) => el.removeAttribute(mark));
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && !el.disabled && !el.readOnly;
  };
  const words = (el) => [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].join(" ");
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const password = inputs.find((el) => el.type === "password" && !/new-password/.test(el.autocomplete));
  const code = inputs.find((el) => el !== password && ["text", "tel", "number", ""].includes(el.type) &&
    (/one-time-code/.test(el.autocomplete) || (/otp|totp|2fa|mfa|verif|passcode|security.?code|auth.?code/i.test(words(el)) && !/user|email|login|phone|mobile/i.test(el.name + el.id))));
  const user = inputs.find((el) => el !== password && el !== code && ["text", "email", "tel", ""].includes(el.type) &&
    (/username|email/.test(el.autocomplete) || el.type === "email" || /user|email|login|account|identifier|phone|mobile/i.test(words(el))));
  const field = password || code || user;
  const scope = field && field.form ? field.form : document;
  const buttons = [...scope.querySelectorAll("button, input[type=submit], [role=button]")].filter(shown);
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  const submit = buttons.find((el) => field && field.form && el.type === "submit") ||
    buttons.find((el) => /^(sign ?in|log ?in|continue|next|submit|verify|sign on|proceed)$/i.test(label(el)));
  for (const [name, el] of [["user", user], ["password", password], ["code", code], ["submit", submit]])
    if (el) el.setAttribute(mark, name);
  const captcha = Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], iframe[src*="arkoselabs"]'));
  return { user: Boolean(user), userValue: user ? user.value : "", password: Boolean(password),
    code: Boolean(code), submit: Boolean(submit), captcha, url: location.href };
})()`;

const FOCUS = (name: string) => `(() => {
  const el = document.querySelector('[${MARK}="${name}"]');
  if (!el) return false;
  el.focus();
  el.select && el.select();
  return document.activeElement === el;
})()`;

const CLICK = `(() => {
  const el = document.querySelector('[${MARK}="submit"]');
  if (!el) return false;
  el.click();
  return true;
})()`;

const CLEAR_PASSWORD = `(() => {
  for (const el of document.querySelectorAll('input[type=password]')) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
})()`;

export async function scanFields(tabId: number): Promise<SignInFields | undefined> {
  const value = await evaluate(tabId, SCAN).catch(() => undefined);
  return value && typeof value === "object" ? (value as SignInFields) : undefined;
}

/** Selects the marked field and types the value into it with the keyboard. */
export async function typeInto(tabId: number, field: string, value: string): Promise<boolean> {
  if (!(await evaluate(tabId, FOCUS(field)).catch(() => false))) return false;
  await withBrowserDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: value });
  });
  return true;
}

/** Presses the form's button, or Enter in the field when there is none. */
export async function submitForm(tabId: number): Promise<void> {
  if (await evaluate(tabId, CLICK).catch(() => false)) return;
  await withBrowserDebugger(tabId, async (debuggee) => {
    for (const type of ["keyDown", "keyUp"] as const)
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
  });
}

export function clearPasswords(tabId: number): Promise<void> {
  return evaluate(tabId, CLEAR_PASSWORD).then(
    () => undefined,
    () => undefined,
  );
}

/** Waits for the page to move on after a submit: new fields, a new address, or nothing left. */
export async function waitForChange(
  tabId: number,
  before: SignInFields,
  timeoutMs = 12_000,
): Promise<SignInFields | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: SignInFields | undefined;
  await new Promise((resolve) => setTimeout(resolve, 800));
  while (Date.now() < deadline) {
    last = await scanFields(tabId);
    if (last && changed(before, last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

function changed(before: SignInFields, after: SignInFields): boolean {
  return (
    after.url !== before.url ||
    after.password !== before.password ||
    after.code !== before.code ||
    after.captcha !== before.captcha
  );
}

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const result = await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      silent: true,
    }),
  );
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value;
}
