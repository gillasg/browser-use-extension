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

/** The help of one command, with the host's own program name when it is not browserkit. */
export function commandHelp(command: Command, program = PROGRAM): string {
  const help = command.help.trimEnd();
  return program === PROGRAM ? help : help.replace(/\bbrowserkit\b/g, program);
}

export function usageText(commands: Command[], program = PROGRAM): string {
  const groups = [...new Set(commands.map((command) => command.group))];
  const lines = [
    `${program}: let agents use your real Chrome, and turn sites into APIs and data.`,
    "",
    `  ${program} <command> [arguments] [--flags]`,
    `  ${program} <command> --help`,
    "",
  ];
  for (const group of groups) {
    lines.push(group);
    const width = Math.max(...commands.map((command) => command.name.length)) + 2;
    for (const command of commands.filter((item) => item.group === group))
      lines.push(`  ${command.name.padEnd(width)}${command.summary}`);
    lines.push("");
  }
  lines.push(`Run \`${program} <command> --help\` for the arguments and flags of one command.`);
  return lines.join("\n");
}
