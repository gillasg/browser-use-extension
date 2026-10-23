import {
  federate,
  inputParams,
  listSites,
  serve as serveSites,
  siteMapper,
  watch as watchOperation,
  type FederateTarget,
} from "@browserkit/tools/site-to-api";
import { callParams, flag, has, type Args } from "../args.js";
import { out, printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";
import { mappedModel } from "./site-map.js";

// Using a mapped site: list it, list what it can do, call one, watch one, ask several at once.

async function sites(args: Args): Promise<number> {
  const sites = await listSites();
  if (has(args, "json")) printJson(sites);
  else
    printRows(
      sites.map((site) => [site.site, `${site.operations} operations`, site.updated.slice(0, 10)]),
    );
  return 0;
}

async function ops(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site) throw new Error("Usage: browserkit ops <site> [--json]");
  const model = await mappedModel(site);
  if (has(args, "json")) {
    printJson({
      site: model.site,
      operations: model.operations.map((op) => ({
        id: op.id,
        method: op.method,
        path: op.path,
        inputs: inputParams(op).map((param) => param.name),
        role: op.role,
        capabilities: op.capabilities ?? [],
        volatile: op.volatile ?? [],
      })),
      pages: model.pages.map((page) => ({ id: page.id, path: page.path })),
    });
    return 0;
  }
  for (const op of model.operations) {
    const inputs = inputParams(op).map((param) => param.name);
    const capabilities = op.capabilities?.length ? `\t[${op.capabilities.join(", ")}]` : "";
    const volatile = op.volatile?.length ? `\tvolatile: ${op.volatile.join(", ")}` : "";
    out(`${op.id}\t${op.method} ${op.path}\t${inputs.join(", ")}${capabilities}${volatile}`);
  }
  for (const page of model.pages) out(`${page.id}\tPAGE ${page.path}`);
  return 0;
}

async function call(args: Args): Promise<number> {
  const [site, operation, json] = args.positional;
  if (!site || !operation)
    throw new Error(
      "Usage: browserkit call <site> <operation> [json] [--param k=v] [--all] [--max-items n] [--transport page|direct]",
    );
  const transport = flag(args, "transport");
  const api = await siteMapper(
    site,
    transport === "page" || transport === "direct" ? { transport } : {},
  );
  const params = callParams(args, json);
  if (has(args, "all") || flag(args, "max-items")) {
    const items: unknown[] = [];
    for await (const item of api.paginate(operation, params, {
      maxItems: Number(flag(args, "max-items") ?? 10_000),
    }))
      items.push(item);
    printJson(items);
    return 0;
  }
  const result = api.pageEndpoint(operation)
    ? await api.fetchPage(operation, params as Record<string, string>)
    : await api.call(operation, params);
  printJson(result);
  return 0;
}

async function watch(args: Args): Promise<number> {
  const [site, operation, json] = args.positional;
  if (!site || !operation)
    throw new Error(
      "Usage: browserkit watch <site> <operation> [json] [--key field] [--items path] [--name n]",
    );
  const options = Object.fromEntries(
    (["key", "items", "name"] as const).flatMap((name) => {
      const value = flag(args, name);
      return value ? [[name, value]] : [];
    }),
  );
  printJson(await watchOperation(site, operation, callParams(args, json), options));
  return 0;
}

/** `site:operation` (or `site:operation:{"q":"x"}`) → a federate target. */
function federateTarget(entry: string, shared: Record<string, unknown>): FederateTarget {
  const [site, operation, ...rest] = entry.split(":");
  if (!site || !operation) throw new Error(`federate needs <site>:<operation>, not "${entry}"`);
  if (!rest.length) return { site, operation, params: shared };
  return { site, operation, params: JSON.parse(rest.join(":")) as Record<string, unknown> };
}

async function runFederate(args: Args): Promise<number> {
  if (!args.positional.length)
    throw new Error(
      'Usage: browserkit federate <site>:<operation> [<site>:<operation> ...] [--params \'{"q":"x"}\'] [--key field]',
    );
  const shared = callParams(args);
  const key = flag(args, "key");
  const maxItems = flag(args, "max-items");
  const timeout = flag(args, "timeout");
  const concurrency = flag(args, "concurrency");
  const result = await federate(
    args.positional.map((entry) => federateTarget(entry, shared)),
    {
      ...(key ? { keyBy: key } : {}),
      ...(maxItems ? { maxItems: Number(maxItems) } : {}),
      ...(timeout ? { timeoutMs: Number(timeout) } : {}),
      ...(concurrency ? { concurrency: Number(concurrency) } : {}),
      ...(has(args, "first-wins") ? { firstWins: true } : {}),
    },
  );
  printJson(result);
  return 0;
}

async function rest(args: Args): Promise<number> {
  const port = flag(args, "port");
  const server = await serveSites(port ? { port: Number(port) } : {});
  out(`Serving every mapped site at ${server.url}/#token=${server.token}`);
  out(`Calls need the header x-site-to-api-token: ${server.token}`);
  await new Promise(() => undefined);
  return 0;
}

export const sitesCommand: Command = {
  name: "sites",
  group: "Use a site",
  summary: "list mapped sites",
  help: `Usage: browserkit sites [--json]

  --json   one JSON object per site, with its operation count and update date`,
  run: sites,
};

export const opsCommand: Command = {
  name: "ops",
  group: "Use a site",
  summary: "list what a mapped site can do, with its inputs and capabilities",
  help: `Usage: browserkit ops <site> [--json]

Each operation shows its inputs, what it is for (search, list, detail, price, availability) and
where in its answer a value is minted per call and expires (volatile).`,
  run: ops,
};

export const callCommand: Command = {
  name: "call",
  group: "Use a site",
  summary: "call one operation of a mapped site",
  help: `Usage: browserkit call <site> <operation> [json]
       browserkit call <site> <operation> --param <name>=<value> ...

  --param k=v          one input (repeatable); a JSON object fills many at once
  --all                walk every page of a paginated operation
  --max-items <n>      stop after n items (implies --all)
  --transport <t>      page (inside the site, with its cookies and signing) or direct (from Node)
  --json               accepted for symmetry: the answer is always JSON`,
  run: call,
};

export const watchCommand: Command = {
  name: "watch",
  group: "Use a site",
  summary: "only the items new or changed since the last watch of that operation",
  help: `Usage: browserkit watch <site> <operation> [json] [--key field] [--items path] [--name n]

  --key <field>     the field that identifies an item (default: id, url, link, href, or a hash)
  --items <path>    dot path to the list in the answer (default: the answer, or its largest list)
  --name <n>        keep a separate history per watch name
  --json            accepted for symmetry: the answer is always JSON`,
  run: watch,
};

export const federateCommand: Command = {
  name: "federate",
  group: "Use a site",
  summary: "ask several mapped sites the same question, and keep the provenance",
  help: `Usage: browserkit federate <site>:<operation> [<site>:<operation> ...] [--params '<json>']

  --params <json>    inputs for every site unless a target carries its own
                     (site:operation:{"q":"lamp"} for one)
  --key <field>      dedupe items across sites by this field
  --max-items <n>    items to take from each site
  --timeout <ms>     per-site deadline
  --concurrency <n>  sites asked at once (default 4)
  --first-wins       stop at the first site that answers with items

Every item says which site answered it; a site that fails, times out or is signed out lands in
\`misses\` with its kind instead of failing the answer.`,
  run: runFederate,
};

export const restCommand: Command = {
  name: "rest",
  group: "Use a site",
  summary: "serve a local REST API and docs for every mapped site",
  help: `Usage: browserkit rest [--port <n>]

Prints the URL and the token calls need (header x-site-to-api-token).`,
  run: rest,
};

export const useGroup = [
  sitesCommand,
  opsCommand,
  callCommand,
  watchCommand,
  federateCommand,
  restCommand,
];
