import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, rmdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// browserkit setup links the skill where coding agents look for skills (~/.agents/skills, and
// ~/.claude/skills unless it already links there), so an agent started on this machine knows
// browserkit exists and how to use it. Safe to run again.

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

/** The skill ships beside the repo; a package install keeps it next to dist. */
function skillSource(): string | undefined {
  const candidates = [
    resolve(dirname(cli), "..", "..", "..", "skills", "browserkit"),
    resolve(dirname(cli), "..", "skills", "browserkit"),
  ];
  return candidates.find((path) => existsSync(join(path, "SKILL.md")));
}

/** Where the link already points, or undefined when nothing is there. */
function linkTarget(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
  } catch {
    return undefined;
  }
}

/** Links folder/browserkit to source, replacing an older link (never a real folder someone made). */
async function linkSkill(folder: string, source: string): Promise<string | undefined> {
  // A skills folder that is itself a link (to ~/.agents/skills) already has the skill.
  const own = linkTarget(folder);
  if (own !== undefined && own !== folder) return undefined;
  const target = join(folder, "browserkit");
  const current = linkTarget(target);
  if (current !== undefined && current !== target) await unlink(target).catch(() => rmdir(target));
  else if (current === target) return target;
  await mkdir(folder, { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  return target;
}

/** Installs the browserkit skill; returns the paths linked, and nothing when it is not shipped. */
export async function installSkill(): Promise<string[]> {
  const source = skillSource();
  if (!source) return [];
  const shared = join(homedir(), ".agents", "skills");
  const agents = await linkSkill(shared, source);
  // Claude Code reads ~/.claude/skills: link it to the shared copy.
  const claude = await linkSkill(join(homedir(), ".claude", "skills"), join(shared, "browserkit"));
  return [agents, claude].filter((path): path is string => Boolean(path));
}
