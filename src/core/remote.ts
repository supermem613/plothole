import {
  ASYNC_ERR_PREFIX,
  ASYNC_OUT_PREFIX,
  ASYNC_RC_PREFIX,
  ASYNC_STATUS_PREFIX,
  KILL_STATUS_PREFIX,
  LOGS_STATUS_PREFIX,
} from "./asyncRun.js";
import { shJoin, shQuote } from "./shquote.js";

// Builders for the remote shell command of each verb. Pure string assembly so
// they can be unit-tested without a live codespace. The impure transport layer
// wraps these with the exit-code sentinel and spawns gh.

// exec is a terminal line, not an argv vector. A string is sent to the remote
// shell verbatim so cd, &&, pipes, redirects, and globs work as typed. An array
// is treated as literal argv and shell-quoted token by token, so metacharacters
// inside a token stay data and never reach the shell as syntax.
export function buildExecCommand(command: string | string[]): string {
  return typeof command === "string" ? command : shJoin(command);
}

export interface ReadRange {
  start: number;
  end?: number;
}

export function buildReadCommand(filePath: string, range?: ReadRange): string {
  if (range === undefined) {
    return `cat ${shQuote(filePath)}`;
  }
  const last = range.end ?? range.start;
  return `sed -n ${shQuote(`${range.start},${last}p`)} ${shQuote(filePath)}`;
}

export type SearchMode = "content" | "files" | "count";

export interface SearchOptions {
  glob?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  maxCount?: number;
  noIgnore?: boolean;
  mode?: SearchMode;
  follow?: boolean;
}

export function buildSearchCommand(query: string, options: SearchOptions = {}): string {
  // Symlink handling note for the next editor. rg already descends a symlinked
  // search ROOT, so source that lives in real directories is found without any
  // follow flag, and real package source in a rush or pnpm monorepo lives in
  // real project directories. --follow only chases symlinks encountered DURING
  // traversal, which on a pnpm store fans out across the whole link graph and
  // turns a sub-second search into minutes. So follow stays OFF by default and
  // is opt-in for the rare case of source reachable only through a nested link.
  const args = ["rg", "--color", "never", "--no-heading"];
  if (options.follow === true) {
    args.push("--follow");
  }
  const mode = options.mode ?? "content";
  if (mode === "files") {
    args.push("--files-with-matches");
  } else if (mode === "count") {
    args.push("--count");
  } else {
    args.push("--line-number", "--with-filename");
  }
  if (options.regex !== true) {
    args.push("--fixed-strings");
  }
  if (options.ignoreCase === true) {
    args.push("--ignore-case");
  }
  if (options.noIgnore === true) {
    args.push("--no-ignore");
  }
  if (options.maxCount !== undefined) {
    args.push("--max-count", String(options.maxCount));
  }
  if (options.glob !== undefined) {
    args.push("--glob", options.glob);
  }
  // Always give rg an explicit search root. With no path and a non-tty stdin,
  // as happens under gh cs ssh, rg reads stdin instead of the working directory
  // and silently finds nothing. The transport applies the caller's cwd, so "."
  // scopes the search to that directory tree.
  args.push("--", query, ".");
  return shJoin(args);
}

// Exact-string replace performed server-side by a tiny node program. The old
// and new strings travel as base64 argv so newlines and quotes never touch the
// remote shell. The replace refuses to run unless the old string occurs exactly
// once, matching the native edit tool's single-match contract.
export function buildEditCommand(filePath: string, oldString: string, newString: string): string {
  const program = [
    "const fs=require('fs');",
    "const[p,o,n]=process.argv.slice(1);",
    "const oldS=Buffer.from(o,'base64').toString('utf8');",
    "const newS=Buffer.from(n,'base64').toString('utf8');",
    "const s=fs.readFileSync(p,'utf8');",
    "const c=s.split(oldS).length-1;",
    "if(c!==1){console.error('plothole-edit: expected exactly 1 occurrence, found '+c);process.exit(3);}",
    "fs.writeFileSync(p,s.split(oldS).join(newS));",
    "process.stdout.write(JSON.stringify({replaced:1}));",
  ].join("");
  const oldB64 = Buffer.from(oldString, "utf8").toString("base64");
  const newB64 = Buffer.from(newString, "utf8").toString("base64");
  return shJoin(["node", "-e", program, filePath, oldB64, newB64]);
}

// Probe the codespace toolchain. Emits key=value lines so the verb can parse a
// flat record without assuming any remote JSON tooling is installed. Install
// state is relative to the working directory, so it is only meaningful when the
// caller supplied a cwd.
export function buildEnvProbe(includeInstallState: boolean): string {
  const lines = [
    `printf 'node=%s\\n' "$(node --version 2>/dev/null)"`,
    `printf 'rush=%s\\n' "$(rush --version 2>/dev/null | head -n1)"`,
    `printf 'pnpm=%s\\n' "$(pnpm --version 2>/dev/null)"`,
    `printf 'git=%s\\n' "$(git --version 2>/dev/null)"`,
    `printf 'rg=%s\\n' "$(rg --version 2>/dev/null | head -n1)"`,
  ];
  if (includeInstallState) {
    lines.push("if [ -d node_modules ]; then echo nodeModules=present; else echo nodeModules=absent; fi");
    lines.push("if [ -d common/temp ]; then echo rushTemp=present; else echo rushTemp=absent; fi");
  }
  return lines.join("; ");
}

// Async exec builders. exec launches the command detached in the codespace and
// then bounded-polls it; wait re-polls an existing run. See asyncRun.ts for the
// marker wire format and the budget rationale.

const SAFE_RUN_ID = /^[A-Za-z0-9-]+$/;

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`unsafe run id: ${runId}`);
  }
}

function clampBudget(budgetSeconds: number): number {
  if (!Number.isFinite(budgetSeconds)) {
    throw new Error(`invalid budget: ${budgetSeconds}`);
  }
  return Math.max(1, Math.floor(budgetSeconds));
}

function runDirAssign(runId: string): string {
  // runId is host-generated and charset-checked, so it embeds literally.
  return `RUN_DIR="$HOME/.plothole/runs/${runId}"`;
}

// The detached runner. It travels to the codespace as base64 so the command can
// never collide with the launcher's own quoting. $1 is the run directory; the
// command's real exit code is written to <rundir>/rc so the host can recover it
// even after the ssh channel that started it has closed. The command body is
// normalized to LF so a CRLF host script file does not inject a stray carriage
// return into the remote bash, which would fail as `$'cmd\r': command not found`.
export function buildRunnerScript(command: string, cwd?: string): string {
  const normalized = command.replace(/\r\n?/g, "\n");
  const body = cwd === undefined ? normalized : `cd ${shQuote(cwd)} && ${normalized}`;
  return [body, 'echo $? > "$1/rc"'].join("\n");
}

// The "no rc yet" tail shared by wait, ready-wait, and logs. A run directory
// with a live pid is genuinely still running; one whose pid is gone died without
// recording a result, so it is reported dead rather than perpetually running.
// kill -0 only probes existence, it sends no signal, so it is safe to poll.
function livenessBranch(statusPrefix: string): string[] {
  return [
    'elif [ -f "$RUN_DIR/pid" ] && kill -0 "$(cat "$RUN_DIR/pid")" 2>/dev/null; then',
    `  printf '\\n${statusPrefix}running\\n'`,
    "else",
    `  printf '\\n${statusPrefix}dead\\n'`,
    "fi",
  ];
}

// Poll for the rc file at a 1s interval up to the budget, then emit a marker
// stream describing the run. This is a bounded poll, not a blind wait: it breaks
// as soon as the command finishes. On completion it base64-encodes stdout and
// stderr (-w0 keeps each on one line) and removes the run directory. Shared by
// exec after launch and by the standalone wait verb.
export function buildAsyncWait(runId: string, budgetSeconds: number): string {
  assertSafeRunId(runId);
  const budget = clampBudget(budgetSeconds);
  return [
    runDirAssign(runId),
    `if [ ! -d "$RUN_DIR" ]; then printf '\\n${ASYNC_STATUS_PREFIX}missing\\n'; exit 0; fi`,
    "i=0",
    `while [ "$i" -lt ${budget} ]; do`,
    '  [ -f "$RUN_DIR/rc" ] && break',
    "  sleep 1",
    "  i=$((i+1))",
    "done",
    'if [ -f "$RUN_DIR/rc" ]; then',
    '  __rc=$(cat "$RUN_DIR/rc")',
    '  __out=$(base64 -w0 "$RUN_DIR/out" 2>/dev/null)',
    '  __err=$(base64 -w0 "$RUN_DIR/err" 2>/dev/null)',
    `  printf '\\n${ASYNC_STATUS_PREFIX}done\\n'`,
    `  printf '${ASYNC_RC_PREFIX}%s\\n' "$__rc"`,
    `  printf '${ASYNC_OUT_PREFIX}%s\\n' "$__out"`,
    `  printf '${ASYNC_ERR_PREFIX}%s\\n' "$__err"`,
    '  rm -rf "$RUN_DIR"',
    ...livenessBranch(ASYNC_STATUS_PREFIX),
  ].join("\n");
}

// Launch the command detached, then wait on it up to the budget. nohup plus full
// fd redirection plus backgrounding detaches the command from the ssh channel so
// this call returns while a long build keeps running. All launcher shell is
// POSIX so it works under both bash and dash login shells.
export function buildAsyncExec(
  runId: string,
  command: string,
  options: { cwd?: string; budgetSeconds: number },
): string {
  return `${buildLaunchBlock(runId, command, options.cwd)}\n${buildAsyncWait(runId, options.budgetSeconds)}`;
}

// The detached-launch half shared by the plain exec and the --ready-when exec.
// The pid-file guard makes the launch at-most-once so a transport retry of a
// dropped ssh connection can never start the command twice. run.sh is launched
// under a login shell (bash -l) so it sources the Codespaces profile and the
// command sees GITHUB_USER, CODESPACE_NAME, auth tokens, and the codespace PATH,
// matching the user's integrated terminal. Without this a remote build succeeds
// but its deploy uploads to an unauthorized blob path and 403s.
function buildLaunchBlock(runId: string, command: string, cwd?: string): string {
  assertSafeRunId(runId);
  const runnerB64 = Buffer.from(buildRunnerScript(command, cwd), "utf8").toString("base64");
  return [
    runDirAssign(runId),
    'if [ ! -f "$RUN_DIR/pid" ]; then',
    '  mkdir -p "$RUN_DIR"',
    `  printf %s '${runnerB64}' | base64 -d > "$RUN_DIR/run.sh"`,
    '  nohup bash -l "$RUN_DIR/run.sh" "$RUN_DIR" > "$RUN_DIR/out" 2> "$RUN_DIR/err" < /dev/null &',
    '  echo $! > "$RUN_DIR/pid"',
    "fi",
  ].join("\n");
}

// A readiness condition for --ready-when. tcp waits for a listener on a port;
// log waits for a regex to appear in the run's stdout. Both let a long-lived
// process (a dev server, a watch build) report ready while it keeps running,
// instead of forcing the caller to choose between blocking and a blind poll.
export type ReadySpec = { kind: "tcp"; port: number } | { kind: "log"; pattern: string };

// Pure: parse a --ready-when string into a structured spec. tcp:PORT (alias
// port:PORT) waits for a listening socket; log:REGEX waits for the pattern in
// stdout. Kept here so it is unit-testable without a live codespace.
export function parseReadySpec(spec: string): ReadySpec {
  const index = spec.indexOf(":");
  if (index < 0) {
    throw new Error(`invalid --ready-when: ${spec}; use tcp:PORT or log:REGEX`);
  }
  const kind = spec.slice(0, index).trim().toLowerCase();
  const value = spec.slice(index + 1);
  if (kind === "tcp" || kind === "port") {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid --ready-when port: ${value}`);
    }
    return { kind: "tcp", port };
  }
  if (kind === "log") {
    if (value.length === 0) {
      throw new Error("invalid --ready-when log pattern: empty");
    }
    return { kind: "log", pattern: value };
  }
  throw new Error(`unknown --ready-when kind: ${kind}; use tcp:PORT or log:REGEX`);
}

// A shell test that exits 0 once the readiness condition holds. tcp inspects
// listening sockets with ss and matches the exact port at the end of the local
// address column so :35565 never also matches :135565. log decodes its regex
// from base64 so no metacharacter has to survive the launcher's own quoting.
function buildReadyCheck(ready: ReadySpec): string {
  if (ready.kind === "tcp") {
    return `ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':${ready.port}$'`;
  }
  const patternB64 = Buffer.from(ready.pattern, "utf8").toString("base64");
  return `__pat=$(printf %s '${patternB64}' | base64 -d); grep -qE -- "$__pat" "$RUN_DIR/out" 2>/dev/null`;
}

// Poll for either completion or the readiness condition, up to the budget. On
// completion it collects and removes the run like buildAsyncWait. On readiness
// it emits a ready marker with a stdout snapshot and leaves the run intact so it
// keeps running and a later wait can still collect the final result. The ready
// branch additionally requires a live pid: a log gate matches the accumulated
// stdout file, which outlives the process, so a suspended or crashed run whose
// stdout still holds the marker must fall through to dead rather than report
// ready forever.
export function buildAsyncReadyWait(runId: string, budgetSeconds: number, ready: ReadySpec): string {
  assertSafeRunId(runId);
  const budget = clampBudget(budgetSeconds);
  const readyCheck = buildReadyCheck(ready);
  return [
    runDirAssign(runId),
    `if [ ! -d "$RUN_DIR" ]; then printf '\\n${ASYNC_STATUS_PREFIX}missing\\n'; exit 0; fi`,
    "i=0",
    "__ready=0",
    `while [ "$i" -lt ${budget} ]; do`,
    '  [ -f "$RUN_DIR/rc" ] && break',
    `  if ${readyCheck}; then __ready=1; break; fi`,
    "  sleep 1",
    "  i=$((i+1))",
    "done",
    'if [ -f "$RUN_DIR/rc" ]; then',
    '  __rc=$(cat "$RUN_DIR/rc")',
    '  __out=$(base64 -w0 "$RUN_DIR/out" 2>/dev/null)',
    '  __err=$(base64 -w0 "$RUN_DIR/err" 2>/dev/null)',
    `  printf '\\n${ASYNC_STATUS_PREFIX}done\\n'`,
    `  printf '${ASYNC_RC_PREFIX}%s\\n' "$__rc"`,
    `  printf '${ASYNC_OUT_PREFIX}%s\\n' "$__out"`,
    `  printf '${ASYNC_ERR_PREFIX}%s\\n' "$__err"`,
    '  rm -rf "$RUN_DIR"',
    'elif [ "$__ready" = 1 ] && [ -f "$RUN_DIR/pid" ] && kill -0 "$(cat "$RUN_DIR/pid")" 2>/dev/null; then',
    '  __out=$(base64 -w0 "$RUN_DIR/out" 2>/dev/null)',
    `  printf '\\n${ASYNC_STATUS_PREFIX}ready\\n'`,
    `  printf '${ASYNC_OUT_PREFIX}%s\\n' "$__out"`,
    ...livenessBranch(ASYNC_STATUS_PREFIX),
  ].join("\n");
}

// Launch detached, then wait for completion or the readiness condition. Shares
// the at-most-once launch block with buildAsyncExec, so a ready-gated exec is
// equally safe to retry across a dropped ssh connection.
export function buildAsyncExecReady(
  runId: string,
  command: string,
  options: { cwd?: string; budgetSeconds: number; ready: ReadySpec },
): string {
  return `${buildLaunchBlock(runId, command, options.cwd)}\n${buildAsyncReadyWait(runId, options.budgetSeconds, options.ready)}`;
}

// Non-destructively tail a backgrounded run's stdout and stderr. Unlike
// buildAsyncWait this never removes the run directory and never blocks: it
// returns the last N lines immediately so the caller can watch a long build's
// progress, read its log markers, and decide whether to wait or kill it.
export function buildLogsCommand(runId: string, options: { lines?: number } = {}): string {
  assertSafeRunId(runId);
  const lines = options.lines === undefined ? 200 : Math.max(1, Math.floor(options.lines));
  return [
    runDirAssign(runId),
    `if [ ! -d "$RUN_DIR" ]; then printf '\\n${LOGS_STATUS_PREFIX}missing\\n'; exit 0; fi`,
    `__out=$(tail -n ${lines} "$RUN_DIR/out" 2>/dev/null | base64 -w0)`,
    `__err=$(tail -n ${lines} "$RUN_DIR/err" 2>/dev/null | base64 -w0)`,
    'if [ -f "$RUN_DIR/rc" ]; then',
    '  __rc=$(cat "$RUN_DIR/rc")',
    `  printf '\\n${LOGS_STATUS_PREFIX}done\\n'`,
    `  printf '${ASYNC_RC_PREFIX}%s\\n' "$__rc"`,
    ...livenessBranch(LOGS_STATUS_PREFIX),
    `printf '${ASYNC_OUT_PREFIX}%s\\n' "$__out"`,
    `printf '${ASYNC_ERR_PREFIX}%s\\n' "$__err"`,
  ].join("\n");
}

// Stop a backgrounded run and its whole subprocess tree, then remove the run
// directory. nohup does not put the runner in its own process group, so there is
// no pgid to signal; the descendants are collected breadth-first with pgrep,
// which is the portable way to stop a build that spawned its own children. The
// run directory is removed so a later wait reports the run as gone.
export function buildKillCommand(runId: string): string {
  assertSafeRunId(runId);
  return [
    runDirAssign(runId),
    `if [ ! -d "$RUN_DIR" ]; then printf '\\n${KILL_STATUS_PREFIX}missing\\n'; exit 0; fi`,
    'if [ ! -f "$RUN_DIR/pid" ]; then',
    `  printf '\\n${KILL_STATUS_PREFIX}not-running\\n'`,
    '  rm -rf "$RUN_DIR"',
    "  exit 0",
    "fi",
    '__root=$(cat "$RUN_DIR/pid")',
    '__pids="$__root"',
    '__queue="$__root"',
    'while [ -n "$__queue" ]; do',
    '  __kids=""',
    '  for __p in $__queue; do __kids="$__kids $(pgrep -P "$__p" 2>/dev/null)"; done',
    "  __queue=$(echo $__kids)",
    '  __pids="$__pids $__queue"',
    "done",
    "kill -TERM $__pids 2>/dev/null || true",
    "kill -KILL $__pids 2>/dev/null || true",
    `printf '\\n${KILL_STATUS_PREFIX}killed\\n'`,
    'rm -rf "$RUN_DIR"',
  ].join("\n");
}
