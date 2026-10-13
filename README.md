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

## Setup

Requires Node.js 22+ and Chrome, Edge or Brave.

```sh
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

It exposes two tools:

| Tool | Arguments | What it does |
|---|---|---|
| `browser_code` | `code` (required), `session`, `timeoutMs` | Runs JavaScript in a persistent REPL inside the browser. The last expression is returned; `console.log` output is included. |
| `browser_tabs` | none | Lists open tabs. |

The tool description carries the full API, so agents can use it without extra setup. [docs/agent-guide.md](docs/agent-guide.md) is the longer reference with examples, for agents and people writing prompts.

Agents without MCP can use the CLI below; `repl` takes the same code.

## CLI

```sh
browser-use-extension repl "page = await browser.openTab('https://example.com'); await bu.state()"
browser-use-extension repl --session research "page.url"
browser-use-extension tabs
browser-use-extension status
browser-use-extension login     # sign in to an AI model, for features that use one
```

`login` opens a sign-in page in your browser for Claude, ChatGPT, GitHub Copilot, OpenRouter and 40+ other providers (subscriptions or API keys). The extension's popup has the same **Connect a model** button. Logins are shared with [pi-ai-login](https://github.com/gillasg/pi-ai-login) and every app built on Pi.

## How it fits together

```
agent ──MCP/CLI──▶ bridge (local, 127.0.0.1) ◀──WebSocket── extension (your Chrome)
```

- `packages/engine`: the browser engine: code runtime, tab ownership, input, observation, hand-off, network recording. It can be embedded in other extensions.
- `apps/extension`: the extension that connects Chrome to the bridge.
- `apps/bridge`: the bridge, native messaging host, CLI and MCP server.

## Development

```sh
pnpm check   # format, types, and an end-to-end test in real Chrome (set CHROME_PATH)
```
