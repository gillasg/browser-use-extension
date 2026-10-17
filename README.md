# Site Boosts

**Make any site behave your way.** Describe a change in plain English, or point at it, and it stays: on every visit, after every redesign. Styles, hidden elements, automatic clicks, network rules and full userscripts and userstyles, in one Chrome extension.

> “Hide Shorts.” “Drop the sponsored results.” “Stop videos from autoplaying.” “Show the price per 100 g next to every product.” “Accept the cookie banner for me.”

## What it does

- **Plain-English boosts.** Type what you want on any page, or click **Point at it** and choose the part to change. A model writes the boost, you see it applied right away, and you keep it, change it by talking, or discard it.
- **Repairs itself.** Every boost reports what it matched on each visit. When a redesign breaks one, it is rewritten against the new page and the change shows up in its history, with one-click undo.
- **Zap.** Click anything to hide it; shift-click to hide everything like it (every ad card, every “Promoted” row). Hidden elements stay hidden when the page adds more.
- **Look.** Dark mode, colours, fonts, text size, brightness, contrast, saturation, a readable column width, no images. Per site, with live preview.
- **Behaviour.** Click, fill, select, press, scroll and sort, on elements present now and ones that appear later: dismiss pop-ups, fill your pincode, skip intros, sort by price.
- **Network.** Per-site rules to block, allow and redirect requests and change headers (language, region), plus a one-switch ad and tracker blocker. Rules only apply to the sites you chose.
- **JavaScript when you need it,** with helpers for boosts: `SB.onElement`, `SB.waitFor`, `SB.panel` (a styled panel that page styles cannot touch), `SB.fetch` (any site, with your logins), `SB.get`/`SB.set`, and `SB.api` for site APIs (below).
- **A ⚡ button on each page** with your boosts for that site, on/off switches, and the request box.

## Userscripts and userstyles

Site Boosts runs the scripts and styles you already use.

- **Install** by opening any `.user.js` or `.user.css` link. You see what it can do (sites, requests to other sites, cookies, downloads, the author's declared antifeatures) and its code before installing; updates show what changed.
- **Every header key:** `@match`, `@include` (globs, `.tld` and regexes), `@exclude`, `@exclude-match`, `@run-at` (`document-start`, `-body`, `-end`, `-idle`, `context-menu`), `@grant`, `@require` (with integrity hashes), `@resource`, `@connect`, `@noframes`, `@inject-into`/`@sandbox`, `@updateURL`/`@downloadURL`, `@icon`, `@tag`, `@antifeature`, localised names.
- **The API:** `GM_getValue`/`setValue`/`deleteValue`/`listValues`, the batch versions, value change listeners across tabs, `GM_xmlhttpRequest` (any method and body, binary, progress, timeouts, abort, and headers browsers normally forbid, such as `Cookie`, `Referer` and `User-Agent`), `GM_addStyle` (also on pages whose security policy blocks inline styles), `GM_addElement`, `GM_getResourceText`/`URL`, `GM_registerMenuCommand` (in the toolbar menu), `GM_openInTab`, `GM_notification`, `GM_setClipboard`, `GM_download`, `GM_cookie`, `GM_getTab`/`saveTab`/`getTabs`, `GM_audio`, `GM_info`, `GM_log`, `unsafeWindow`, `window.onurlchange`, and the promise-based `GM.*` versions.
- **Userstyles** in the UserCSS format: `@-moz-document` sections (`domain`, `url-prefix`, `url`, `regexp`), and settings (`@var` colour pickers, checkboxes, dropdowns, numbers, ranges) you change in the manager, for plain CSS, `uso` and LESS styles.
- **Automatic updates,** installed for you or only announced, as you prefer.

## The manager

A dashboard of every boost, script and style, with search, tags, filters, switches and run order. Each one opens in an editor with syntax highlighting, completion and error checking, where you can:

- change it by talking,
- edit its CSS, JavaScript, hidden elements, look, actions, network rules and added HTML,
- see every revision with a diff and restore any of them,
- edit its stored values,
- see its health on recent visits, and repair it.

Also: an error console, per-site and global switches, a list of sites where nothing ever runs, and pause-everything.

## Backup and sharing

- Export everything as JSON or as a ZIP (scripts and styles as their own files); import either, or plain `.user.js` and `.user.css` files.
- Share a boost as a short code anyone with Site Boosts can paste in. Shared boosts carry their JavaScript; the person receiving it sees the same review as for an install.
- Keep several computers in step through any WebDAV folder (Nextcloud, ownCloud, a NAS).

API keys and passwords never leave in a backup.

## Models

A model is only needed to write and repair boosts. Use your own key with Anthropic, OpenAI, Google Gemini or OpenRouter, or any OpenAI-compatible server, including a local one. Keys stay in the browser and go only to the provider. A companion extension that is already signed in to a model can lend it instead.

## Site APIs

Connect a [site-to-api](https://github.com/gillasg/site-to-api) server (`site-to-api serve`) and boosts can call the APIs of the sites you mapped, with your logins: price history next to a product, the same item on another shop, your own data on a dashboard. The model sees which operations exist when it writes a boost. Without a server, a companion extension that has site APIs answers these calls instead, and an extension that embeds the engine can answer them itself.

## Install

1. Download the latest build, or build it yourself:
   ```bash
   pnpm install
   pnpm build
   ```
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose the `build` folder.
3. The setup page opens: switch on **Allow User Scripts** for Site Boosts (needed only for boosts with JavaScript and for userscripts).

Works in Chrome and Edge 135 or newer.

Shortcuts: Alt+Shift+Z hides things on the page, Alt+Shift+B opens the ⚡ panel.

## For other extensions

Another extension can ask Site Boosts to list, save, switch and write boosts (`chrome.runtime.sendMessage(id, { type: "site-boosts", kind, data })` with `ping`, `boosts.list`, `boosts.get`, `boosts.save`, `boosts.toggle`, `boosts.delete`, `boosts.author`, `boosts.keep`, `boosts.discard`), and Site Boosts can ask it for a model (`model.complete`) or hand it requests from boosts (`SB.companion("watch", { url, price })`). Only the companion chosen in the settings is allowed.

## Development

```bash
pnpm install
pnpm check      # format, types, lint, build, unit and end-to-end tests
pnpm pack       # a ZIP for the Chrome Web Store
```

The end-to-end tests run the built extension in a private, headless Chrome for Testing (set `CHROME_PATH`) against a local test site and a scripted model. CI runs them on Windows, macOS and Linux.

## License

MIT
