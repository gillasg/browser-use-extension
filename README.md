# Browser Use Extension

Let coding agents and any MCP client use **your real Chrome**: your tabs, your logins, while you watch.

Most browser-automation tools start a separate, empty browser. This one runs inside the Chrome you already use, through an extension, so an agent can work on sites you are signed in to, in tabs you can see and take over.

## What agents get

- **A persistent JavaScript REPL in the browser.** One tool call runs a whole workflow (open, read, click, type, extract) instead of one call per click. Variables and tabs survive between calls.
- **Compact page state.** `bu.state()` prints numbered interactive elements and visible text; `bu.click(id)` and `bu.type(id, text)` act on them. Raw `page.evaluate`, `page.cdp` and screenshots (optionally labelled with ids) are there when needed.
- **Site APIs.** Record a site's own requests while doing a task once (`page.network.start()`), with full headers, bodies and the script that made each call, and export them as HAR. Then call them from inside the page with `page.replay(id, changes)` or `page.request(url)`, so cookies, CSRF tokens and request signing all work: often many times faster than clicking.
- **Data without scraping.** `page.data()` returns a page's embedded JSON (JSON-LD, `__NEXT_DATA__`, app state) and metadata; `page.markdown()` returns its main content as clean Markdown.
- **Many pages at once.** `browser.fetch(url)` fetches with your cookies and no tab; `browser.pool(urls, fn)` works through pages in parallel tabs, with retries and back-off.
- **Site skills.** Flows an agent works out are saved per site and offered to every later session.
- **Hand-off.** When a step needs you (signing in, a 2FA code, a choice), the agent calls `bu.handoff("…")`. The tab comes forward with the request and **Done / Cancel**, and the agent continues from there.
- **Many agents, one browser.** Each session owns the tabs it opens; sessions do not interfere with each other or with your own tabs.
- **Visible work.** An on-page cursor shows where the agent clicks.
- **Boosts.** `browser.boosts.save({ name, sites, css, zaps, actions, network, js })` saves a lasting change to a site that applies on every visit, from the [Site Boosts](https://github.com/gillasg/site-boosts) engine built in.
- **Crawling and site APIs.** The `crawl` tool reads pages and whole sites as Markdown ([browser-crawl](https://github.com/gillasg/browser-crawl)); `site_api` turns sites mapped from your own traffic into APIs (the site-to-api engine, built in).

## Setup

Requires Node.js 22+ and Chrome, Edge or Brave.

```sh
node scripts/link-repos.mjs   # fetches and builds browser-crawl next to this folder
pnpm install
pnpm build
node apps/bridge/dist/cli.js setup
```

`setup` registers the native messaging host and prints the remaining steps:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `apps/extension/build`.
2. Add the MCP server to your agent: the command is `node /path/to/apps/bridge/dist/cli.js mcp` (stdio). `setup` prints ready-to-paste config.

The bridge starts on demand and stays in the background. The extension's toolbar popup shows whether it is connected.

## Connecting an agent (MCP)

The MCP server speaks stdio. Point any MCP client at it:

```json
{
  "mcpServers": {
    "browser-use-extension": {
      "command": "node",
      "args": ["/path/to/browser-use-extension/apps/bridge/dist/cli.js", "mcp"]
    }
  }
}
```

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.browser-use-extension]
command = "node"
args = ["/path/to/browser-use-extension/apps/bridge/dist/cli.js", "mcp"]
```

It exposes four tools:

| Tool           | Arguments                                 | What it does                                                                                                                |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `browser_code` | `code` (required), `session`, `timeoutMs` | Runs JavaScript in a persistent REPL inside the browser. The last expression is returned; `console.log` output is included. |
| `browser_tabs` | none                                      | Lists open tabs.                                                                                                            |
| `crawl`        | `action`, `url`, `query`, `limit`, …      | Scrapes a page, crawls a site or section, maps a site's URLs, or searches Google, as Markdown and data.                     |
| `site_api`     | `action`, `site`, `operation`, `params`   | Lists mapped sites and their operations, calls one, or maps a site from captures saved with `page.network.save()`.          |

The tool description carries the full API, so agents can use it without extra setup. [docs/agent-guide.md](docs/agent-guide.md) is the longer reference with examples, for agents and people writing prompts.

Agents without MCP can use the CLI below; `repl` takes the same code.

## CLI

```sh
browser-use-extension repl "page = await browser.openTab('https://example.com'); await bu.state()"
browser-use-extension repl --session research "page.url"
browser-use-extension tabs
browser-use-extension status
```

Agents bring their own model: this extension does not sign in to model providers and does not provide a model to other extensions. A companion asking for one is told that none is available.

## How it fits together

```
agent ──MCP/CLI──▶ bridge (local, 127.0.0.1) ◀──WebSocket── extension (your Chrome)
```

- `packages/engine`: the browser engine: code runtime, tab ownership, input, observation, hand-off, network recording. It can be embedded in other extensions.
- `packages/boosts`: the Site Boosts engine, with its own extension build, embedded in the engine as `browser.boosts`.
- `apps/extension`: the extension that connects Chrome to the bridge.
- `apps/bridge`: the bridge, native messaging host, CLI and MCP server.
- `packages/protocol`: the messages the engine speaks.
- `packages/tools`: the `crawl` and `site_api` tools built on the packages below.
- `packages/site-api`: the site mapping and calling library (the site-to-api engine, maintained here).

browser-crawl is its own project, linked from a sibling folder (`link:../browser-crawl`) instead of being copied, so a change there is used here on the next build. `node scripts/link-repos.mjs --revisions` prints the revision of each linked repo.

## Development

```sh
node scripts/link-repos.mjs   # once, and after pulling browser-crawl
pnpm check                    # format, types, and an end-to-end test in real Chrome (set CHROME_PATH)
pnpm test:boosts              # Site Boosts unit tests
CHROME_PATH=... pnpm test:boosts:e2e   # Site Boosts in headless Chrome for Testing
```
