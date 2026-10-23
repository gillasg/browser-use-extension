import type { Args } from "./args.js";

/** One browserkit command: what it is for, its own help, and what it does. */
export interface Command {
  name: string;
  group: string;
  summary: string;
  /** Printed by `browserkit <command> --help`. */
  help: string;
  run(args: Args): Promise<number>;
}

const PROGRAM = "browserkit";

export function usageText(commands: Command[]): string {
  const groups = [...new Set(commands.map((command) => command.group))];
  const lines = [
    "browserkit: let agents use your real Chrome, and turn sites into APIs and data.",
    "",
    "  browserkit <command> [arguments] [--flags]",
    `  ${PROGRAM} <command> --help`,
    "",
  ];
  for (const group of groups) {
    lines.push(group);
    const width = Math.max(...commands.map((command) => command.name.length)) + 2;
    for (const command of commands.filter((item) => item.group === group))
      lines.push(`  ${command.name.padEnd(width)}${command.summary}`);
    lines.push("");
  }
  lines.push(`Run \`${PROGRAM} <command> --help\` for the arguments and flags of one command.`);
  return lines.join("\n");
}

export function commandHelp(command: Command): string {
  return command.help.trimEnd();
}
