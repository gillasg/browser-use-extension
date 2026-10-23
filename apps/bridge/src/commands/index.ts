import type { Command } from "../usage.js";
import { boostsCommand } from "./boosts.js";
import { browserGroup } from "./browser.js";
import { crawlCommand, findCommand, scrapeCommand, searchCommand, urlMapCommand } from "./crawl.js";
import { mapGroup } from "./site-map.js";
import { keepGroup } from "./site-keep.js";
import { useGroup } from "./site-use.js";

// Every capability the MCP tools and the bundled packages have, as a command.
export const COMMANDS: Command[] = [
  ...browserGroup,
  crawlCommand,
  scrapeCommand,
  urlMapCommand,
  searchCommand,
  findCommand,
  ...mapGroup,
  ...useGroup,
  ...keepGroup,
  boostsCommand,
];
