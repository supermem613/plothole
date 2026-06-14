import { runGh, type ProcessResult } from "./gh.js";
import { parseSentinel, wrapRemote, TIMEOUT_EXIT_CODE } from "./sentinel.js";
import {
  buildAsyncExec,
  buildAsyncExecReady,
  buildAsyncReadyWait,
  buildAsyncWait,
  buildKillCommand,
  buildLogsCommand,
  type ReadySpec,
} from "./remote.js";
import {
  parseAsyncOutput,
  parseKillOutput,
  parseLogsOutput,
  type AsyncRunOutcome,
  type KillOutcome,
  type LogsOutcome,
} from "./asyncRun.js";
import { PlotholeError } from "./errors.js";

// Bounded retry for transient ssh transport drops. gh occasionally fails to
// establish the ssh channel ("error reading server preface", "use of closed
// network connection", "error getting ssh server details"), which aborts a
// command that never actually ran. These are connection-establishment failures,
// so retrying is safe: the remote side produced no output and executed nothing.
export const SSH_MAX_ATTEMPTS = 3;

const SSH_TRANSPORT_PATTERNS = [
  /error reading server preface/i,
  /use of closed network connection/i,
  /error getting ssh server details/i,
  /failed to invoke SSH RPC/i,
  /connection reset by peer/i,
  /connection refused/i,
  /broken pipe/i,
  /unexpected EOF/i,
  /i\/o timeout/i,
];

export function isSshTransportError(stderr: string): boolean {
  return SSH_TRANSPORT_PATTERNS.some((pattern) => pattern.test(stderr));
}

// Retry the gh invocation only when all three hold: it failed, the remote
// produced no recognizable output, and the failure looks like an ssh transport
// drop. The producedRemoteOutput guard is what keeps a command that genuinely
// ran and exited nonzero from being retried: its sentinel or status marker is
// present, so the retry never double-executes side effects. Retries are issued
// immediately with no artificial delay; each gh spawn re-establishes the channel
// from scratch, which is the natural spacing between attempts.
export async function retryOnSshDrop(
  invoke: () => Promise<ProcessResult>,
  producedRemoteOutput: (stdout: string) => boolean,
  maxAttempts: number = SSH_MAX_ATTEMPTS,
): Promise<ProcessResult> {
  let gh = await invoke();
  let attempt = 1;
  while (
    attempt < maxAttempts &&
    gh.code !== 0 &&
    !producedRemoteOutput(gh.stdout) &&
    isSshTransportError(gh.stderr)
  ) {
    attempt += 1;
    gh = await invoke();
  }
  return gh;
}

// One place that runs a remote command in a codespace: wrap it with the
// exit-code sentinel, hand the wrapped script to `gh codespace ssh` as a single
// argv element, then recover the true exit code from the sentinel.

export interface RemoteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sentinelFound: boolean;
}

// Wall-clock budget for a synchronous remote verb (read/search/edit/env and the
// session root check). Held under the ~60s MCP request deadline so a runaway
// command surfaces plothole's own actionable timeout error before an MCP client
// gives up on the call. Long work goes through exec, which backgrounds instead.
export const SYNC_TIMEOUT_SECONDS = 45;

export async function runInCodespace(
  codespace: string,
  remoteCommand: string,
  options: { cwd?: string; stdin?: string } = {},
): Promise<RemoteResult> {
  const wrapped = wrapRemote(remoteCommand, {
    cwd: options.cwd,
    timeoutSeconds: SYNC_TIMEOUT_SECONDS,
    detachStdin: options.stdin === undefined,
  });
  const gh = await retryOnSshDrop(
    () =>
      runGh(
        ["codespace", "ssh", "-c", codespace, "--", wrapped],
        options.stdin === undefined ? {} : { stdin: options.stdin },
      ),
    (stdout) => parseSentinel(stdout).sentinelFound,
  );
  const parsed = parseSentinel(gh.stdout);
  const exitCode = parsed.sentinelFound ? parsed.exitCode : gh.code;
  if (parsed.sentinelFound && exitCode === TIMEOUT_EXIT_CODE) {
    throw new PlotholeError(
      `remote command timed out after ${SYNC_TIMEOUT_SECONDS}s`,
      `the command did not finish within plothole's ${SYNC_TIMEOUT_SECONDS}s budget in ${codespace}. For a search, narrow the root or --cwd to a smaller directory; a --glob does not prune the walk. For a long build or test, run it through exec, which backgrounds past the budget and returns a runId.`,
    );
  }
  return {
    exitCode,
    stdout: parsed.stdout,
    stderr: gh.stderr,
    sentinelFound: parsed.sentinelFound,
  };
}

// Async exec transport. The command is launched detached in the codespace and
// this call returns either the collected result or a still-running handle. Both
// runners share finishAsync, which converts an unparseable response (gh or ssh
// failure) into an actionable error rather than a silent run state.

async function finishAsync(
  codespace: string,
  runId: string,
  script: string,
): Promise<AsyncRunOutcome> {
  const gh = await retryOnSshDrop(
    () => runGh(["codespace", "ssh", "-c", codespace, "--", script]),
    (stdout) => parseAsyncOutput(stdout).status !== "unknown",
  );
  const outcome = parseAsyncOutput(gh.stdout);
  if (outcome.status === "unknown") {
    throw new PlotholeError(
      `async run ${runId}: could not read run status from the codespace`,
      gh.stderr.trim() || "the codespace returned no status marker; confirm it is reachable with `plothole doctor`",
    );
  }
  return outcome;
}

// Stop a backgrounded run and its subprocess tree in the codespace. The kill
// script is idempotent (re-running it on an already-removed run reports
// "missing"), so a transport retry is always safe here.
export async function killInCodespace(codespace: string, runId: string): Promise<KillOutcome> {
  const wrapped = wrapRemote(buildKillCommand(runId), { timeoutSeconds: SYNC_TIMEOUT_SECONDS });
  const gh = await retryOnSshDrop(
    () => runGh(["codespace", "ssh", "-c", codespace, "--", wrapped]),
    (stdout) => parseKillOutput(stdout) !== "unknown",
  );
  const outcome = parseKillOutput(gh.stdout);
  if (outcome === "unknown") {
    throw new PlotholeError(
      `kill ${runId}: could not confirm the run was stopped`,
      gh.stderr.trim() || "the codespace returned no kill status; confirm it is reachable with `plothole doctor`",
    );
  }
  return outcome;
}

export function runAsyncExec(
  codespace: string,
  runId: string,
  command: string,
  options: { cwd?: string; budgetSeconds: number },
): Promise<AsyncRunOutcome> {
  return finishAsync(codespace, runId, buildAsyncExec(runId, command, options));
}

export function runAsyncExecReady(
  codespace: string,
  runId: string,
  command: string,
  options: { cwd?: string; budgetSeconds: number; ready: ReadySpec },
): Promise<AsyncRunOutcome> {
  return finishAsync(codespace, runId, buildAsyncExecReady(runId, command, options));
}

export function runAsyncWait(
  codespace: string,
  runId: string,
  budgetSeconds: number,
): Promise<AsyncRunOutcome> {
  return finishAsync(codespace, runId, buildAsyncWait(runId, budgetSeconds));
}

// Re-evaluate a backgrounded run's readiness condition on a later wait. The run
// was launched detached past the budget, so this standalone poll re-checks the
// same --ready-when the exec used and reports ready as soon as it holds, instead
// of waiting only for completion that a never-exiting dev server never reaches.
export function runAsyncReadyWait(
  codespace: string,
  runId: string,
  budgetSeconds: number,
  ready: ReadySpec,
): Promise<AsyncRunOutcome> {
  return finishAsync(codespace, runId, buildAsyncReadyWait(runId, budgetSeconds, ready));
}

// Tail a backgrounded run without collecting it. The logs script is read-only
// in the codespace (it never removes the run directory), so a transport retry is
// always safe; the producedRemoteOutput guard only blocks a retry once a real
// logs marker has been seen.
export async function runLogs(
  codespace: string,
  runId: string,
  lines?: number,
): Promise<Exclude<LogsOutcome, { status: "unknown" }>> {
  const gh = await retryOnSshDrop(
    () => runGh(["codespace", "ssh", "-c", codespace, "--", buildLogsCommand(runId, { lines })]),
    (stdout) => parseLogsOutput(stdout).status !== "unknown",
  );
  const outcome = parseLogsOutput(gh.stdout);
  if (outcome.status === "unknown") {
    throw new PlotholeError(
      `logs ${runId}: could not read run output from the codespace`,
      gh.stderr.trim() || "the codespace returned no logs marker; confirm it is reachable with `plothole doctor`",
    );
  }
  return outcome;
}
