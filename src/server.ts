#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { toolTextResult } from "./mcp/format.js";
import { PlotholeError } from "./core/errors.js";
import {
  cleanVerb,
  editVerb,
  envVerb,
  execVerb,
  forwardVerb,
  killVerb,
  logsVerb,
  readVerb,
  runsVerb,
  rushVerb,
  searchVerb,
  sessionVerb,
  waitVerb,
} from "./core/verbs.js";
import {
  presentClean,
  presentEdit,
  presentEnv,
  presentExec,
  presentForward,
  presentKill,
  presentLogs,
  presentRead,
  presentRuns,
  presentRush,
  presentSearch,
} from "./present.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string; version: string };

// Every tool operates INSIDE the active codespace. Host files and processes are
// not visible here. The world-hint is repeated in each description so an agent
// routing between host tools and codespace tools cannot confuse the two.
const WORLD = "Operates INSIDE the active GitHub Codespace; host files and processes are not visible here.";

// One error boundary for every tool so a failed verb becomes a structured error
// envelope with a hint rather than an unhandled rejection that drops the MCP
// connection.
async function guard(produce: () => Promise<unknown>) {
  try {
    return toolTextResult({ ok: true, data: await produce() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = err instanceof PlotholeError ? err.hint : undefined;
    return toolTextResult({ ok: false, error: message, hint });
  }
}

export function createPlotholeServer(): McpServer {
  const server = new McpServer({ name: pkg.name, version: pkg.version });

  server.registerTool(
    "exec",
    {
      title: "Exec in codespace",
      description:
        `Run a command and return its real exit code, stdout, and stderr. Pass command as a STRING to run a shell line (cd, &&, pipes, redirects, and globs all work, e.g. "cd /workspaces/app && rush build"), or as an ARRAY of literal argv tokens (e.g. ["rush","build"]) when you want no shell interpretation. For a large or heavily quoted script, write it to a host file and pass scriptFile instead of command; it is read on the host and run verbatim, so nothing has to survive shell quoting. Long commands are backgrounded: if the command runs longer than ~45s this returns {status:"running", runId} instead, and you call the wait tool with that runId to collect the result. For a long-lived process like a dev server, pass readyWhen ("tcp:PORT" to wait for a listening port, or "log:REGEX" to wait for a line in stdout) to return {status:"ready", runId} as soon as it is serving while it keeps running. ${WORLD}`,
      inputSchema: {
        command: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('shell command line as a string, e.g. "cd src && rush build"; or literal argv tokens, e.g. ["rush","build"]; omit when using scriptFile'),
        scriptFile: z
          .string()
          .optional()
          .describe("host file path whose contents are run as a shell line inside the codespace; use for large or heavily quoted scripts instead of inlining command"),
        cwd: z.string().optional().describe("working directory inside the codespace"),
        readyWhen: z
          .string()
          .optional()
          .describe('return once a readiness condition holds while the process keeps running: "tcp:PORT" (a listening port) or "log:REGEX" (a pattern in stdout)'),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) =>
      guard(async () =>
        presentExec(
          await execVerb({
            codespace: args.codespace,
            cwd: args.cwd,
            command: args.command,
            scriptFile: args.scriptFile,
            readyWhen: args.readyWhen,
          }),
        ),
      ),
  );

  server.registerTool(
    "wait",
    {
      title: "Wait for a backgrounded exec",
      description:
        `Wait for a backgrounded exec (a prior exec that returned status "running") to finish, then collect its exit code, stdout, and stderr. Returns status "running" again if it is still going after ~45s; call wait again to keep polling. ${WORLD}`,
      inputSchema: {
        runId: z.string().describe("the runId returned by a backgrounded exec"),
        codespace: z.string().optional().describe("override the codespace the run is on"),
      },
    },
    async (args) =>
      guard(async () => presentExec(await waitVerb({ codespace: args.codespace, runId: args.runId }))),
  );

  server.registerTool(
    "runs",
    {
      title: "List tracked runs",
      description: `List backgrounded execs the host is still tracking, with each runId, codespace, and command. ${WORLD}`,
      inputSchema: {},
    },
    async () => guard(async () => presentRuns(runsVerb())),
  );

  server.registerTool(
    "clean",
    {
      title: "Prune finished runs",
      description: `Prune tracked runs that already finished or vanished so the runs list stays accurate. A still-running exec is never touched, so this cannot kill a live command. ${WORLD}`,
      inputSchema: {},
    },
    async () => guard(async () => presentClean(await cleanVerb())),
  );

  server.registerTool(
    "kill",
    {
      title: "Kill a backgrounded run",
      description:
        `Stop a backgrounded exec (by its runId) and its subprocesses, then drop the tracked run. Use this to cancel a runaway build; clean only prunes runs that already finished. ${WORLD}`,
      inputSchema: {
        runId: z.string().describe("the runId of the backgrounded exec to stop"),
        codespace: z.string().optional().describe("override the codespace the run is on"),
      },
    },
    async (args) => guard(async () => presentKill(await killVerb({ codespace: args.codespace, runId: args.runId }))),
  );

  server.registerTool(
    "logs",
    {
      title: "Tail a backgrounded run",
      description:
        `Tail a backgrounded exec's stdout and stderr (by its runId) without collecting it. Returns the last lines plus whether it is still running or has finished, so you can watch a long build's progress and read its log markers, then decide to wait or kill. Unlike wait this never blocks and never consumes the run, so a later wait still recovers the full result. ${WORLD}`,
      inputSchema: {
        runId: z.string().describe("the runId of the backgrounded exec to tail"),
        lines: z.number().int().positive().optional().describe("tail this many trailing lines (default 200)"),
        codespace: z.string().optional().describe("override the codespace the run is on"),
      },
    },
    async (args) =>
      guard(async () => presentLogs(await logsVerb({ codespace: args.codespace, runId: args.runId, lines: args.lines }))),
  );

  server.registerTool(
    "read",
    {
      title: "Read codespace file",
      description: `Read a file, optionally a line range. ${WORLD}`,
      inputSchema: {
        path: z.string().describe("file path inside the codespace"),
        start: z.number().int().positive().optional().describe("first line to read (1-based)"),
        end: z.number().int().positive().optional().describe("last line to read (1-based)"),
        cwd: z.string().optional().describe("resolve the path relative to this directory"),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) =>
      guard(async () => {
        const range = args.start === undefined ? undefined : { start: args.start, end: args.end };
        return presentRead(await readVerb({ codespace: args.codespace, cwd: args.cwd, path: args.path, range }));
      }),
  );

  server.registerTool(
    "search",
    {
      title: "Search codespace",
      description: `Search file contents with ripgrep. Source in real directories is found from the repo root, and a symlinked search root is descended automatically, so monorepo package source is found without any extra flag. Set follow only when source is reachable only through a NESTED symlink, since following the full pnpm link graph is slow. Use mode "files" for matching paths only or "count" for per-file counts. ${WORLD}`,
      inputSchema: {
        query: z.string().describe("text or regex to search for"),
        glob: z.string().optional().describe("limit to paths matching this glob"),
        regex: z.boolean().optional().describe("treat query as a regex instead of a literal"),
        ignoreCase: z.boolean().optional().describe("case-insensitive search"),
        maxCount: z.number().int().positive().optional().describe("stop after this many matches per file"),
        noIgnore: z.boolean().optional().describe("also search files normally excluded by .gitignore"),
        follow: z
          .boolean()
          .optional()
          .describe("follow nested symlinks during traversal; off by default because it is slow on pnpm monorepos"),
        mode: z
          .enum(["content", "files", "count"])
          .optional()
          .describe('"content" (default) returns matching lines, "files" returns matching paths, "count" returns per-file counts'),
        cwd: z.string().optional().describe("search relative to this directory"),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) =>
      guard(async () =>
        presentSearch(
          await searchVerb({
            codespace: args.codespace,
            cwd: args.cwd,
            query: args.query,
            search: {
              glob: args.glob,
              regex: args.regex,
              ignoreCase: args.ignoreCase,
              maxCount: args.maxCount,
              noIgnore: args.noIgnore,
              mode: args.mode,
              follow: args.follow,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "edit",
    {
      title: "Edit codespace file",
      description: `Replace an exact string. Fails unless the old string occurs exactly once. ${WORLD}`,
      inputSchema: {
        path: z.string().describe("file path inside the codespace"),
        old: z.string().describe("exact text to replace; must occur exactly once"),
        new: z.string().describe("replacement text"),
        cwd: z.string().optional().describe("resolve a relative path against this directory (defaults to the codespace root)"),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) =>
      guard(async () =>
        presentEdit(
          await editVerb({ codespace: args.codespace, cwd: args.cwd, path: args.path, oldString: args.old, newString: args.new }),
        ),
      ),
  );

  server.registerTool(
    "session",
    {
      title: "Codespace session",
      description: `Set or inspect the active codespace and its workspace root. ${WORLD}`,
      inputSchema: {
        ensure: z.string().optional().describe("set this codespace as active after verifying it exists"),
        setRoot: z
          .string()
          .optional()
          .describe("scope every verb in the codespace to this directory after verifying it exists"),
        clearRoot: z.boolean().optional().describe("remove the configured root so verbs run in the bare login directory"),
        codespace: z.string().optional().describe("codespace whose root to set or clear (defaults to the active one)"),
      },
    },
    async (args) =>
      guard(async () =>
        sessionVerb({
          ensure: args.ensure,
          setRoot: args.setRoot,
          clearRoot: args.clearRoot,
          codespace: args.codespace,
        }),
      ),
  );

  server.registerTool(
    "env",
    {
      title: "Codespace toolchain",
      description: `Describe the codespace toolchain and install state. ${WORLD}`,
      inputSchema: {
        cwd: z.string().optional().describe("report install state relative to this directory"),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) => guard(async () => presentEnv(await envVerb({ codespace: args.codespace, cwd: args.cwd }))),
  );

  server.registerTool(
    "forward",
    {
      title: "Forward a codespace port to the host",
      description:
        `Bridge a codespace TCP port to a host port so a HOST tool (a browser or curl) can reach a service running in the codespace, e.g. a rush dev server. This is the one tool that acts on the host rather than inside the codespace: with port set it starts a forward and reports whether the host port came up; list reports active forwards; stop tears down the forward on a host port. Pair it with exec readyWhen so you forward only once the codespace service is actually serving.`,
      inputSchema: {
        port: z.number().int().positive().optional().describe("the codespace port to forward; omit when using list or stop"),
        localPort: z.number().int().positive().optional().describe("host port to bind (default: same as the codespace port)"),
        list: z.boolean().optional().describe("list the active forwards the host is tracking"),
        stop: z.number().int().positive().optional().describe("stop the forward bound to this host port"),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) =>
      guard(async () =>
        presentForward(
          await forwardVerb({
            codespace: args.codespace,
            port: args.port,
            localPort: args.localPort,
            list: args.list,
            stop: args.stop,
          }),
        ),
      ),
  );

  server.registerTool(
    "rush",
    {
      title: "Rush in codespace",
      description:
        `Run rush from typed parts so a selector cannot be dropped or the port mistyped. Pass subcommand (e.g. "start", "build", "test") and the project closure as a "to" ARRAY of rush selectors (e.g. ["tag:web-app","@scope/app"]). For a watch subcommand (start, build-watch) this auto-gates on the watch ready marker and returns {status:"ready", runId, port} once the dev server is serving while it keeps running; for a run-to-completion subcommand it returns {status:"completed", exitCode}. Either way it scans the output for rushstack build FAILURE markers and surfaces them as failures, so a watch that came up while a sub-build failed is not mistaken for healthy. Long runs background to a runId you collect with wait, tail with logs, or stop with kill. Bridge the returned port with the forward tool to reach the dev server from the host. ${WORLD}`,
      inputSchema: {
        subcommand: z.string().describe('rush subcommand, e.g. "start", "build", or "test"'),
        to: z
          .array(z.string())
          .describe('project closure as rush selectors, e.g. ["tag:web-app","@scope/app"]; at least one is required'),
        port: z.number().int().positive().optional().describe("dev server port for a watch subcommand"),
        extra: z.array(z.string()).optional().describe("extra raw rush args appended after the selectors and port"),
        cwd: z.string().optional().describe("working directory inside the codespace (defaults to the codespace root)"),
        codespace: z.string().optional().describe("override the active codespace name"),
      },
    },
    async (args) =>
      guard(async () =>
        presentRush(
          await rushVerb({
            codespace: args.codespace,
            cwd: args.cwd,
            subcommand: args.subcommand,
            to: args.to,
            port: args.port,
            extra: args.extra,
          }),
        ),
      ),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  await createPlotholeServer().connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMcpServer();
}
