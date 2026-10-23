# @browserkit/site-mapper

Parse any site into a typed API: use it once in your own browser, then call its recorded
endpoints from code, from an agent, or over MCP.

This package began as a snapshot of the standalone
[site-to-api](https://github.com/gillasg/site-to-api) repository on 23 Oct 2026. It is part of the
browserkit now: capabilities are ported into it on purpose, and changes belong here.

- `dist/index.js` is the library, including the mapping pipeline, OpenAPI/client emitters, the
  runtime `siteMapper` and `federate`.
- `dist/runtime/index.js` is the runtime client.
- `dist/cli.js` is the `site-to-api` command line (`record`, `build`, `call`, `watch`, `serve`,
  `mcp`, `export`, `heal`, ...).

Every read operation also says what an app can use it for (`search`, `list`, `detail`, `price`,
`availability`) and marks response values that are minted per call and expire (a stream ticket, a
signed URL). A refused bot wall is a `Challenged` error with the vendor, not a broken API;
`sessionStatus(site)` says whether an exported session exists and is still fresh.

The optional AI features (`describe`, `explore`, `edit`, `name`) take a model from the caller:
pass a `ModelLike` (`{ complete(context) }`) in their options. Nothing in this package signs in
to a model, and calling those features without one fails with a clear error.

```sh
pnpm --filter @browserkit/site-mapper build
node packages/site-mapper/dist/cli.js sites
```

MIT.
