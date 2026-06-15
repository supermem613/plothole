#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import { editCommand } from "./commands/edit.js";
import { cleanCommand } from "./commands/clean.js";
import { forwardCommand } from "./commands/forward.js";
import { killCommand } from "./commands/kill.js";
import { envCommand } from "./commands/env.js";
import { execCommand } from "./commands/exec.js";
import { logsCommand } from "./commands/logs.js";
import { mcpCallCommand, mcpSchemaCommand } from "./commands/mcpDebug.js";
import { mcpConfigCommand } from "./commands/mcpConfig.js";
import { readCommand } from "./commands/read.js";
import { runsCommand } from "./commands/runs.js";
import { rushCommand } from "./commands/rush.js";
import { schemaCommand } from "./commands/schema.js";
import { searchCommand } from "./commands/search.js";
import { sessionCommand } from "./commands/session.js";
import { startMcpServer } from "./server.js";
import { updateCommand } from "./commands/update.js";
import { waitCommand } from "./commands/wait.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("plothole")
  .description("Drive compile, run, test, and edit inside a GitHub Codespace from the host Copilot CLI")
  .version(VERSION);

program
  .command("doctor")
  .description("Health check: verify environment and configuration")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(doctorCommand);

program
  .command("schema [path...]")
  .description("Emit the machine-readable command catalog")
  .option("--summary", "Return only version, command count, and command paths")
  .action((pathArgs: string[] | undefined, opts: { summary?: boolean }) => schemaCommand(pathArgs ?? [], opts, VERSION));

program
  .command("mcp-config")
  .description("Emit MCP config JSON for registering this server with Copilot CLI")
  .action(mcpConfigCommand);

program
  .command("mcp-server")
  .description("Start the stdio MCP server")
  .action(startMcpServer);

program
  .command("mcp-schema")
  .description("Debug this MCP by listing tools through a local MCP client")
  .action(mcpSchemaCommand);

program
  .command("mcp-call <tool> [jsonArgs]")
  .description("Debug this MCP by calling a tool through a local MCP client")
  .action(mcpCallCommand);

program
  .command("update")
  .description("Self-update: git pull, npm install, and rebuild plothole")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(updateCommand);

program
  .command("exec [command...]")
  .description("Run a command inside the active codespace and wait for it to finish, returning its exit code")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .option("--cwd <dir>", "Working directory inside the codespace")
  .option("--script-file <file>", "Run this host script file as a shell line in the codespace")
  .option(
    "--ready-when <spec>",
    "Return once a readiness condition holds while leaving the process running: tcp:PORT or log:REGEX",
  )
  .option("-b, --background", "Return a runId immediately instead of blocking until the command finishes")
  .action((command: string[] | undefined, opts: { codespace?: string; cwd?: string; scriptFile?: string; readyWhen?: string; background?: boolean }) =>
    execCommand(command ?? [], opts),
  );

program
  .command("wait <runId>")
  .description("Wait for a backgrounded exec to finish and collect its result")
  .option("--cs, --codespace <name>", "Override the codespace the run is on")
  .action((runId: string, opts: { codespace?: string }) => waitCommand(runId, opts));

program
  .command("runs")
  .description("List backgrounded execs the host is still tracking")
  .action(() => runsCommand());

program
  .command("clean")
  .description("Prune tracked runs that already finished; never touches a still-running exec")
  .action(() => cleanCommand());

program
  .command("kill <runId>")
  .description("Stop a backgrounded exec and its subprocesses inside the codespace")
  .option("--cs, --codespace <name>", "Override the codespace the run is on")
  .action((runId: string, opts: { codespace?: string }) => killCommand(runId, opts));

program
  .command("logs <runId>")
  .description("Tail a backgrounded exec's stdout and stderr without collecting it")
  .option("--cs, --codespace <name>", "Override the codespace the run is on")
  .option("--lines <n>", "Tail this many trailing lines (default 200)")
  .action((runId: string, opts: { codespace?: string; lines?: string }) => logsCommand(runId, opts));

program
  .command("read <path>")
  .description("Read a file inside the active codespace, optionally a line range")
  .option("--start <n>", "First line to read (1-based)")
  .option("--end <n>", "Last line to read (1-based)")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .option("--cwd <dir>", "Resolve the path relative to this directory")
  .action((path: string, opts: { start?: string; end?: string; codespace?: string; cwd?: string }) =>
    readCommand(path, opts),
  );

program
  .command("search <query>")
  .description("Search file contents inside the active codespace with ripgrep")
  .option("--glob <pattern>", "Limit to paths matching this glob")
  .option("--regex", "Treat the query as a regex instead of a literal")
  .option("--ignore-case", "Case-insensitive search")
  .option("--max-count <n>", "Stop after this many matches per file")
  .option("--include-ignored", "Also search files normally excluded by .gitignore")
  .option("--files", "List only the matching file paths")
  .option("--count", "Print a per-file match count instead of the matching lines")
  .option("--follow", "Follow nested symlinks during traversal (slow on pnpm monorepos; off by default)")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .option("--cwd <dir>", "Search relative to this directory")
  .action(
    (
      query: string,
      opts: {
        glob?: string;
        regex?: boolean;
        ignoreCase?: boolean;
        maxCount?: string;
        includeIgnored?: boolean;
        files?: boolean;
        count?: boolean;
        follow?: boolean;
        codespace?: string;
        cwd?: string;
      },
    ) => searchCommand(query, opts),
  );

program
  .command("edit <path>")
  .description("Replace an exact string in a file inside the active codespace")
  .option("--old <text>", "Exact text to replace; must occur exactly once")
  .option("--new <text>", "Replacement text")
  .option("--old-file <file>", "Read the old string from this host file")
  .option("--new-file <file>", "Read the new string from this host file")
  .option("--cwd <dir>", "Resolve a relative path against this directory (defaults to the codespace root)")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .action(
    (
      path: string,
      opts: { old?: string; new?: string; oldFile?: string; newFile?: string; cwd?: string; codespace?: string },
    ) => editCommand(path, opts),
  );

program
  .command("session")
  .description("Set or inspect the active codespace and its workspace root")
  .option("--ensure <name>", "Set this codespace as active after verifying it exists")
  .option("--set-root <path>", "Scope every verb in the codespace to this directory after verifying it exists")
  .option("--clear-root", "Remove the configured root so verbs run in the bare login directory")
  .option("--cs, --codespace <name>", "Codespace whose root to set or clear (defaults to the active one)")
  .action((opts: { ensure?: string; setRoot?: string; clearRoot?: boolean; codespace?: string }) =>
    sessionCommand(opts),
  );

program
  .command("env")
  .description("Describe the active codespace toolchain and install state")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .option("--cwd <dir>", "Report install state relative to this directory")
  .action((opts: { codespace?: string; cwd?: string }) => envCommand(opts));

program
  .command("forward [port]")
  .description("Forward a codespace TCP port to the host so host tools can reach a codespace service")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .option("--local-port <n>", "Host port to bind (default: same as the codespace port)")
  .option("--list", "List the active forwards the host is tracking")
  .option("--stop <port>", "Stop the forward bound to this host port")
  .action((port: string | undefined, opts: { codespace?: string; localPort?: string; list?: boolean; stop?: string }) =>
    forwardCommand(port, opts),
  );

// Repeatable option collector: each --to or --extra occurrence appends to the
// array so the closure is built up token by token, mirroring rush's own --to.
function collectArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command("rush <subcommand>")
  .description("Run rush in the active codespace from typed parts; auto-gates watch subcommands and scans for build failures")
  .option("--to <selector>", "Project selector to build; repeat for each project in the closure", collectArg, [])
  .option("--port <n>", "Dev server port for a watch subcommand")
  .option("--extra <arg>", "Extra raw rush arg appended after the selectors and port; repeat for each", collectArg, [])
  .option("--cwd <dir>", "Working directory inside the codespace (defaults to the codespace root)")
  .option("--cs, --codespace <name>", "Override the active codespace name")
  .option("-b, --background", "Return a runId immediately instead of blocking until a build finishes")
  .action(
    (subcommand: string, opts: { to: string[]; port?: string; extra: string[]; cwd?: string; codespace?: string; background?: boolean }) =>
      rushCommand(subcommand, opts),
  );

if (process.argv.slice(2).length === 0) {
  process.stdout.write(`plothole v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
