export type CommandEffect = "read" | "write" | "network" | "local" | "mutate-remote";

export type FlagType = "boolean" | "string" | "number";

export interface FlagSpec {
  name: string;
  type: FlagType;
  summary: string;
  default?: boolean | string | number;
}

export interface CommandSpec {
  path: string[];
  summary: string;
  effect: CommandEffect;
  input: {
    positionals: string[];
    flags: FlagSpec[];
  };
  output: {
    documented: boolean;
    schema?: string;
  };
  examples: string[];
}

export const commandSpecs: CommandSpec[] = [
  {
    path: ["doctor"],
    summary: "Verify environment and configuration.",
    effect: "read",
    input: {
      positionals: [],
      flags: [{ name: "--json", type: "boolean", summary: "Emit machine-readable JSON instead of human output." }],
    },
    output: { documented: true, schema: "HealthCheckResult[]" },
    examples: ["doctor --json"],
  },
  {
    path: ["schema"],
    summary: "Emit the machine-readable command catalog.",
    effect: "read",
    input: {
      positionals: ["path"],
      flags: [{ name: "--summary", type: "boolean", summary: "Return only version, command count, and command paths." }],
    },
    output: { documented: true, schema: "CommandCatalog" },
    examples: ["schema", "schema doctor --summary"],
  },
  {
    path: ["mcp-config"],
    summary: "Emit MCP config JSON for registering plothole with Copilot CLI.",
    effect: "read",
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: "McpConfig" },
    examples: ["mcp-config"],
  },
  {
    path: ["mcp-server"],
    summary: "Start the plothole stdio MCP server.",
    effect: "local",
    input: { positionals: [], flags: [] },
    output: { documented: false, schema: "MCP stdio transport" },
    examples: ["mcp-server"],
  },
  {
    path: ["mcp-schema"],
    summary: "List plothole MCP tools through a local MCP client.",
    effect: "read",
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: "ListToolsResult" },
    examples: ["mcp-schema"],
  },
  {
    path: ["mcp-call"],
    summary: "Call an plothole MCP tool through a local MCP client.",
    effect: "local",
    input: {
      positionals: ["tool", "jsonArgs"],
      flags: [],
    },
    output: { documented: true, schema: "CallToolResult" },
    examples: ["mcp-call session", "mcp-call exec {\"command\":[\"echo\",\"hi\"]}"],
  },
  {
    path: ["update"],
    summary: "Self-update this plothole checkout with git pull, npm install, and rebuild.",
    effect: "write",
    input: {
      positionals: [],
      flags: [{ name: "--json", type: "boolean", summary: "Emit machine-readable JSON instead of human output." }],
    },
    output: { documented: true, schema: "UpdateResult" },
    examples: ["update --json"],
  },
  {
    path: ["exec"],
    summary: "Run a command inside the active codespace and wait for it to finish, returning its exit code.",
    effect: "mutate-remote",
    input: {
      positionals: ["command"],
      flags: [
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
        { name: "--cwd", type: "string", summary: "Working directory inside the codespace." },
        { name: "--script-file", type: "string", summary: "Run this host script file as a shell line in the codespace." },
        {
          name: "--ready-when",
          type: "string",
          summary: "Return once a readiness condition holds while the process keeps running: tcp:PORT or log:REGEX.",
        },
        { name: "--background", type: "boolean", summary: "Return a runId immediately instead of blocking until the command finishes (alias -b)." },
      ],
    },
    output: { documented: true, schema: "ExecResult" },
    examples: ["exec -- rush build", "exec -- 'cd src && rush build'", "exec --cwd packages/foo -- npm test", "exec --script-file ./build.sh", "exec --ready-when tcp:35565 -- rush start", "exec --background -- rush build"],
  },
  {
    path: ["wait"],
    summary: "Wait for a backgrounded exec to finish and collect its result.",
    effect: "read",
    input: {
      positionals: ["runId"],
      flags: [{ name: "--codespace", type: "string", summary: "Override the codespace the run is on (alias --cs)." }],
    },
    output: { documented: true, schema: "ExecResult" },
    examples: ["wait 3f9a1c2e-..."],
  },
  {
    path: ["runs"],
    summary: "List backgrounded execs the host is still tracking.",
    effect: "read",
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: "RunsResult" },
    examples: ["runs"],
  },
  {
    path: ["clean"],
    summary: "Prune tracked runs that already finished; never touches a still-running exec.",
    effect: "write",
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: "CleanResult" },
    examples: ["clean"],
  },
  {
    path: ["kill"],
    summary: "Stop a backgrounded exec and its subprocesses inside the codespace.",
    effect: "mutate-remote",
    input: {
      positionals: ["runId"],
      flags: [{ name: "--codespace", type: "string", summary: "Override the codespace the run is on (alias --cs)." }],
    },
    output: { documented: true, schema: "KillResult" },
    examples: ["kill 3f9a1c2e-..."],
  },
  {
    path: ["logs"],
    summary: "Tail a backgrounded exec's stdout and stderr without collecting it.",
    effect: "read",
    input: {
      positionals: ["runId"],
      flags: [
        { name: "--lines", type: "number", summary: "Tail this many trailing lines (default 200)." },
        { name: "--codespace", type: "string", summary: "Override the codespace the run is on (alias --cs)." },
      ],
    },
    output: { documented: true, schema: "LogsResult" },
    examples: ["logs 3f9a1c2e-...", "logs 3f9a1c2e-... --lines 50"],
  },
  {
    path: ["read"],
    summary: "Read a file inside the active codespace, optionally a line range.",
    effect: "read",
    input: {
      positionals: ["path"],
      flags: [
        { name: "--start", type: "number", summary: "First line to read (1-based)." },
        { name: "--end", type: "number", summary: "Last line to read (1-based)." },
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
        { name: "--cwd", type: "string", summary: "Resolve the path relative to this directory." },
      ],
    },
    output: { documented: true, schema: "ReadResult" },
    examples: ["read package.json", "read src/index.ts --start 1 --end 40"],
  },
  {
    path: ["search"],
    summary: "Search file contents inside the active codespace with ripgrep.",
    effect: "read",
    input: {
      positionals: ["query"],
      flags: [
        { name: "--glob", type: "string", summary: "Limit to paths matching this glob." },
        { name: "--regex", type: "boolean", summary: "Treat the query as a regex instead of a literal." },
        { name: "--ignore-case", type: "boolean", summary: "Case-insensitive search." },
        { name: "--max-count", type: "number", summary: "Stop after this many matches per file." },
        { name: "--include-ignored", type: "boolean", summary: "Also search files normally excluded by .gitignore." },
        { name: "--files", type: "boolean", summary: "List only the matching file paths." },
        { name: "--count", type: "boolean", summary: "Print a per-file match count instead of the matching lines." },
        { name: "--follow", type: "boolean", summary: "Follow nested symlinks during traversal (slow on pnpm monorepos; off by default)." },
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
        { name: "--cwd", type: "string", summary: "Search relative to this directory." },
      ],
    },
    output: { documented: true, schema: "SearchResult" },
    examples: ["search TODO --glob 'src/**'", "search \"function main\" --regex", "search FabIcon --files"],
  },
  {
    path: ["edit"],
    summary: "Replace an exact string in a file inside the active codespace.",
    effect: "mutate-remote",
    input: {
      positionals: ["path"],
      flags: [
        { name: "--old", type: "string", summary: "Exact text to replace; must occur exactly once." },
        { name: "--new", type: "string", summary: "Replacement text." },
        { name: "--old-file", type: "string", summary: "Read the old string from this host file." },
        { name: "--new-file", type: "string", summary: "Read the new string from this host file." },
        { name: "--cwd", type: "string", summary: "Resolve a relative path against this directory (defaults to the codespace root)." },
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
      ],
    },
    output: { documented: true, schema: "EditResult" },
    examples: ["edit src/app.ts --old 'foo' --new 'bar'"],
  },
  {
    path: ["session"],
    summary: "Set or inspect the active codespace and its workspace root.",
    effect: "write",
    input: {
      positionals: [],
      flags: [
        { name: "--ensure", type: "string", summary: "Set this codespace as active after verifying it exists." },
        { name: "--set-root", type: "string", summary: "Scope every verb in the codespace to this directory after verifying it exists." },
        { name: "--clear-root", type: "boolean", summary: "Remove the configured root so verbs run in the bare login directory." },
        { name: "--codespace", type: "string", summary: "Codespace whose root to set or clear, defaults to the active one (alias --cs)." },
      ],
    },
    output: { documented: true, schema: "SessionResult" },
    examples: ["session", "session --ensure sample-codespace --set-root /workspaces/app", "session --clear-root"],
  },
  {
    path: ["env"],
    summary: "Describe the active codespace toolchain and install state.",
    effect: "read",
    input: {
      positionals: [],
      flags: [
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
        { name: "--cwd", type: "string", summary: "Report install state relative to this directory." },
      ],
    },
    output: { documented: true, schema: "EnvResult" },
    examples: ["env", "env --cwd /workspaces/app"],
  },
  {
    path: ["forward"],
    summary: "Forward a codespace TCP port to the host so host tools can reach a codespace service.",
    effect: "network",
    input: {
      positionals: ["port"],
      flags: [
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
        { name: "--local-port", type: "number", summary: "Host port to bind (default: same as the codespace port)." },
        { name: "--list", type: "boolean", summary: "List the active forwards the host is tracking." },
        { name: "--stop", type: "number", summary: "Stop the forward bound to this host port." },
      ],
    },
    output: { documented: true, schema: "ForwardResult" },
    examples: ["forward 35565", "forward --list", "forward --stop 35565"],
  },
  {
    path: ["rush"],
    summary: "Run rush in the active codespace from typed parts; auto-gates watch subcommands and scans for build failures.",
    effect: "mutate-remote",
    input: {
      positionals: ["subcommand"],
      flags: [
        { name: "--to", type: "string", summary: "Project selector to build; repeat for each project in the closure, e.g. --to tag:web-app." },
        { name: "--port", type: "number", summary: "Dev server port for a watch subcommand." },
        { name: "--extra", type: "string", summary: "Extra raw rush arg appended after the selectors and port; repeat for each." },
        { name: "--cwd", type: "string", summary: "Working directory inside the codespace (defaults to the codespace root)." },
        { name: "--codespace", type: "string", summary: "Override the active codespace name (alias --cs)." },
        { name: "--background", type: "boolean", summary: "Return a runId immediately instead of blocking until a build finishes (alias -b)." },
      ],
    },
    output: { documented: true, schema: "RushResult" },
    examples: [
      "rush start --to tag:web-app --to @scope/app --port 46435",
      "rush build --to @scope/app",
    ],
  },
];

function pathMatchesPrefix(path: string[], prefix: string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

export function buildSchema(cliVersion: string, pathPrefix: string[] = [], summary = false) {
  const commands = commandSpecs.filter((command) => pathMatchesPrefix(command.path, pathPrefix));
  if (summary) {
    return {
      schemaVersion: 1,
      cliVersion,
      commandCount: commands.length,
      commandPaths: commands.map((command) => command.path),
    };
  }

  return {
    schemaVersion: 1,
    cliVersion,
    envelope: {
      stdout: "JSON only for non-interactive commands when --json or schema is used",
      stderr: "progress, diagnostics, and human narration",
      successEnvelope: ["ok", "command", "data"],
      errorEnvelope: ["ok", "command", "error", "hint"],
    },
    globalFlags: [
      { name: "--help", type: "boolean", summary: "Show command help." },
      { name: "--version", type: "boolean", summary: "Show CLI version." },
    ],
    commands,
    errorCodes: [],
    exitCodes: [
      { code: 0, meaning: "Success." },
      { code: 1, meaning: "Command failed." },
    ],
  };
}
