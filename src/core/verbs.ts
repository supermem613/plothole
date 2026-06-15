import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_ASYNC_BUDGET_SECONDS, type AsyncRunOutcome, type KillOutcome, type LogsOutcome } from "./asyncRun.js";
import { PlotholeError } from "./errors.js";
import { scanFailures, type FailureScan } from "./failures.js";
import { listForwards, startForward, stopForward, type ForwardView } from "./forward.js";
import { listCodespaces, type CodespaceInfo } from "./gh.js";
import {
  buildEditCommand,
  buildEnvProbe,
  buildExecCommand,
  buildReadCommand,
  buildSearchCommand,
  parseReadySpec,
  type ReadRange,
  type ReadySpec,
  type SearchOptions,
} from "./remote.js";
import { buildRushArgs, rushReadyWhen } from "./rush.js";
import { classifySpfxDeploy, type SpfxDeployStatus } from "./spfxDeploy.js";
import { shQuote } from "./shquote.js";
import {
  clearRoot,
  getActiveCodespace,
  getRoot,
  getRun,
  listRuns,
  recordRun,
  removeRun,
  setActiveCodespace,
  setRoot,
  setRunRush,
  type RunRecord,
  type RushRunMeta,
} from "./state.js";
import {
  killInCodespace,
  runAsyncExec,
  runAsyncExecReady,
  runAsyncReadyWait,
  runAsyncWait,
  runInCodespace,
  runLogs,
  type RemoteResult,
} from "./transport.js";

// Verb functions shared by both faces. The CLI parses argv into these and the
// MCP server maps tool-call JSON into these, so the two faces can never drift.

export function resolveCodespace(explicit?: string): string {
  const codespace = explicit ?? getActiveCodespace();
  if (codespace === undefined || codespace === "") {
    throw new PlotholeError(
      "no codespace selected",
      "Run `plothole session --ensure <name>` to set the active codespace, or pass --codespace <name>.",
    );
  }
  return codespace;
}

// Resolve a verb's effective working directory. An explicit absolute --cwd wins
// outright. Otherwise the codespace's persisted root, set with session
// --set-root, is the base: a relative --cwd resolves under it and a missing
// --cwd means the root itself. With no root configured the result is unchanged
// from a bare login shell, so the root is an opt-in scoping bypass, never a
// hardcoded path baked into the tool.
export function resolveCwd(codespace: string, explicitCwd?: string): string | undefined {
  const root = getRoot(codespace);
  if (explicitCwd === undefined) {
    return root;
  }
  if (explicitCwd.startsWith("/")) {
    return explicitCwd;
  }
  if (root === undefined) {
    return explicitCwd;
  }
  return `${root.replace(/\/+$/, "")}/${explicitCwd}`;
}

// exec is always launched detached in the codespace and polled up to a budget.
// A command that finishes in time returns completed with its real exit code and
// output; one that outlives the budget returns a running handle the caller polls
// with waitVerb. This is what keeps long builds from timing out the MCP face.
export interface ExecCompleted {
  status: "completed";
  codespace: string;
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  // Build failures parsed out of the output. A long run can exit 0 or come up
  // ready while a sub-build failed, so this is surfaced independently of the
  // exit code to keep a partially failed build from looking healthy.
  failures?: FailureScan;
  // Rush provenance rehydrated from the run record on a resumed wait, so a
  // resumed completed run keeps the same rush context as the live one.
  rush?: RushRunMeta;
}

export interface ExecRunning {
  status: "running";
  codespace: string;
  runId: string;
  runDir: string;
  // Rush provenance rehydrated from the run record on a resumed wait, so the
  // resumed path can present the same forward hint as the initial rush run.
  rush?: RushRunMeta;
}

// A ready exec met its --ready-when condition while the process keeps running.
// The caller gets a stdout snapshot and the runId to tail with logs, collect
// with wait, or stop with kill.
export interface ExecReady {
  status: "ready";
  codespace: string;
  runId: string;
  runDir: string;
  stdout: string;
  failures?: FailureScan;
  // Rush provenance rehydrated from the run record on a resumed wait, so the
  // resumed path can present the same forward hint as the initial rush run.
  rush?: RushRunMeta;
  // For a rush watch with a port, whether the served scenario actually deployed.
  // A watch can come up ready while its deploy-only closure 403'd, so this gates
  // a browser or curl handoff independently of the process being up.
  deploy?: SpfxDeployStatus;
}

export type ExecResult = ExecCompleted | ExecRunning | ExecReady;

// Scan a run's captured output for build failures. stdout and stderr are scanned
// together so a failure summary on either stream is caught.
function failuresIn(stdout: string, stderr = ""): FailureScan | undefined {
  return scanFailures(stderr.length > 0 ? `${stdout}\n${stderr}` : stdout);
}

// The run directory is inside the codespace, not on the host. Surfacing it lets
// the agent reach a backgrounded run's raw out/err directly when it wants more
// than the logs verb returns.
function codespaceRunDir(runId: string): string {
  return `~/.plothole/runs/${runId}`;
}

function hasCommand(command: string | string[] | undefined): boolean {
  if (command === undefined) {
    return false;
  }
  return typeof command === "string" ? command.trim().length > 0 : command.length > 0;
}

// Resolve the effective exec input from an inline command or a host script file.
// A script file is read on the host as raw bytes and run verbatim as a shell
// line, so a heavily quoted or multi-line script never has to survive the host
// shell that launched plothole. The two inputs are mutually exclusive so the
// command source is never ambiguous.
export function resolveExecInput(
  command: string | string[] | undefined,
  scriptFile: string | undefined,
): string | string[] {
  if (scriptFile !== undefined) {
    if (hasCommand(command)) {
      throw new PlotholeError(
        "provide a command or --script-file, not both",
        "Pass the command inline, or point --script-file at a host script, but not both.",
      );
    }
    let text: string;
    try {
      text = readFileSync(scriptFile, "utf8");
    } catch {
      throw new PlotholeError(
        `cannot read script file: ${scriptFile}`,
        "Pass a readable host file path to run as a shell script in the codespace.",
      );
    }
    if (text.trim().length === 0) {
      throw new PlotholeError("script file is empty", "The --script-file has no runnable content.");
    }
    return text;
  }
  if (!hasCommand(command)) {
    throw new PlotholeError(
      "exec requires a command",
      "Pass the command after `--`, e.g. `plothole exec -- rush build`, or use --script-file <path>.",
    );
  }
  return command as string | string[];
}

// Both faces call execVerb/waitVerb/logsVerb with no second argument, so they run
// the real transport. Tests inject a stub transport to exercise the verb's
// mapping of an outcome to a result without a live codespace, mirroring
// cleanVerb's injectable poll. The default values keep production call sites
// unchanged.
export interface ExecDeps {
  exec(
    codespace: string,
    runId: string,
    command: string,
    options: { cwd?: string; budgetSeconds: number },
  ): Promise<AsyncRunOutcome>;
  execReady(
    codespace: string,
    runId: string,
    command: string,
    options: { cwd?: string; budgetSeconds: number; ready: ReadySpec },
  ): Promise<AsyncRunOutcome>;
}

export interface WaitDeps {
  wait(codespace: string, runId: string, budgetSeconds: number): Promise<AsyncRunOutcome>;
  readyWait(codespace: string, runId: string, budgetSeconds: number, ready: ReadySpec): Promise<AsyncRunOutcome>;
}

export interface LogsDeps {
  logs(codespace: string, runId: string, lines?: number): Promise<Exclude<LogsOutcome, { status: "unknown" }>>;
}

const realExecDeps: ExecDeps = { exec: runAsyncExec, execReady: runAsyncExecReady };
const realWaitDeps: WaitDeps = { wait: runAsyncWait, readyWait: runAsyncReadyWait };
const realLogsDeps: LogsDeps = { logs: runLogs };

export async function execVerb(
  options: {
    codespace?: string;
    cwd?: string;
    command?: string | string[];
    scriptFile?: string;
    readyWhen?: string;
    readyBudgetSeconds?: number;
  },
  deps: ExecDeps = realExecDeps,
): Promise<ExecResult> {
  const resolved = resolveExecInput(options.command, options.scriptFile);
  const codespace = resolveCodespace(options.codespace);
  const cwd = resolveCwd(codespace, options.cwd);
  const command = buildExecCommand(resolved);
  const runId = randomUUID();
  const ready = options.readyWhen === undefined ? undefined : parseReadySpec(options.readyWhen);
  // A caller that will run its own bounded probe after a ready result can reserve
  // part of the budget for it, so the readiness poll plus the probe still fit one
  // round trip. A plain exec keeps the full budget.
  const readyBudget = options.readyBudgetSeconds ?? DEFAULT_ASYNC_BUDGET_SECONDS;
  const outcome =
    ready === undefined
      ? await deps.exec(codespace, runId, command, { cwd, budgetSeconds: DEFAULT_ASYNC_BUDGET_SECONDS })
      : await deps.execReady(codespace, runId, command, {
        cwd,
        budgetSeconds: readyBudget,
        ready,
      });
  if (outcome.status === "done") {
    return { status: "completed", codespace, runId, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr, failures: failuresIn(outcome.stdout, outcome.stderr) };
  }
  if (outcome.status === "ready") {
    // The readiness condition held while the process keeps running. Persist the
    // run, including its readyWhen, so logs/wait/kill can resolve the codespace
    // and a later wait can re-evaluate the same readiness gate.
    recordRun({ runId, codespace, command, cwd, startedAt: new Date().toISOString(), readyWhen: options.readyWhen });
    return { status: "ready", codespace, runId, runDir: codespaceRunDir(runId), stdout: outcome.stdout, failures: failuresIn(outcome.stdout) };
  }
  if (outcome.status === "running") {
    // The command outlived the budget. Persist it, including any readyWhen, so a
    // later waitVerb can resolve the codespace and re-check readiness without the
    // caller repeating --cs or --ready-when.
    recordRun({ runId, codespace, command, cwd, startedAt: new Date().toISOString(), readyWhen: options.readyWhen });
    return { status: "running", codespace, runId, runDir: codespaceRunDir(runId) };
  }
  // exec just created the run directory, so a missing run is a protocol anomaly.
  throw new PlotholeError(
    "exec could not start the command in the codespace",
    "The codespace did not report a run status. Confirm it is reachable with `plothole doctor`.",
  );
}

// Run an exec and, unlike the budgeted single-shot execVerb the MCP face uses,
// block until it reaches a terminal state by polling wait. A hand-run CLI exec
// has no client deadline to beat, so a long build is awaited to its real exit
// code instead of handing back a runId the caller must wait on. A ready dev
// server is terminal here, so a --ready-when watch returns once it is up rather
// than blocking on a process that never exits. waitVerb re-checks a persisted
// readyWhen on each poll, so a watch resolves to ready and a plain command to
// completed through the same loop.
export async function execToCompletionVerb(
  options: {
    codespace?: string;
    cwd?: string;
    command?: string | string[];
    scriptFile?: string;
    readyWhen?: string;
  },
  deps: ExecDeps = realExecDeps,
  waitDeps: WaitDeps = realWaitDeps,
  run: RemoteRunner = runInCodespace,
): Promise<ExecResult> {
  let result = await execVerb(options, deps);
  while (result.status === "running") {
    result = await waitVerb({ codespace: result.codespace, runId: result.runId }, waitDeps, run);
  }
  return result;
}

// A rush result mirrors an exec result but is rush-flavored: it records which
// subcommand ran, whether it is a long-lived watch or a one-shot build, and the
// port a watch serves on, so the agent never has to re-derive any of that from
// the raw command. failures is carried straight through from the exec scan so a
// watch that came up while a sub-build failed is not mistaken for healthy.
export interface RushResult {
  status: "completed" | "running" | "ready";
  codespace: string;
  runId: string;
  subcommand: string;
  mode: "watch" | "once";
  port?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runDir?: string;
  failures?: FailureScan;
  // For a watch with a port, whether the served scenario actually deployed. A
  // watch can come up ready while its deploy-only closure 403'd, so this gates a
  // browser or curl handoff independently of the watch process being up.
  deploy?: SpfxDeployStatus;
}

// rush drives the codespace dev loop from typed parts. It builds the rush argv,
// auto-selects the watch ready gate for watch subcommands, and runs it through
// execVerb so it inherits the same backgrounding, liveness, and failure scan.
// rush is generic OSS, so the application closure lives entirely in the caller's
// --to selectors, never here.
export async function rushVerb(
  options: { codespace?: string; cwd?: string; subcommand: string; to: string[]; port?: number; extra?: string[] },
  deps: ExecDeps = realExecDeps,
  run: RemoteRunner = runInCodespace,
): Promise<RushResult> {
  const argv = buildRushArgs({
    subcommand: options.subcommand,
    to: options.to,
    port: options.port,
    extra: options.extra,
  });
  const readyWhen = rushReadyWhen(options.subcommand);
  const mode: "watch" | "once" = readyWhen === undefined ? "once" : "watch";
  // A watch with a port asserts its deploy state after reaching ready, so reserve
  // that probe's bound out of the readiness budget. The readiness poll plus the
  // probe then fit one async round trip instead of stacking past the budget.
  const willProbe = readyWhen !== undefined && options.port !== undefined;
  const exec = await execVerb(
    {
      codespace: options.codespace,
      cwd: options.cwd,
      command: argv,
      readyWhen,
      readyBudgetSeconds: willProbe ? DEFAULT_ASYNC_BUDGET_SECONDS - DEPLOY_PROBE_TIMEOUT_SECONDS : undefined,
    },
    deps,
  );
  const base = { codespace: exec.codespace, runId: exec.runId, subcommand: options.subcommand, mode, port: options.port };
  if (exec.status === "completed") {
    return { ...base, status: "completed", exitCode: exec.exitCode, stdout: exec.stdout, stderr: exec.stderr, failures: exec.failures };
  }
  // A backgrounded rush run is already recorded by execVerb. Patch its rush
  // framing onto the record so a later wait or logs can rebuild the forward
  // hint instead of degrading to a generic exec payload that lost the port.
  setRunRush(exec.runId, { subcommand: options.subcommand, mode, port: options.port });
  if (exec.status === "ready") {
    // A watch that reaches ready directly inside the budget asserts its deploy
    // state in the same call, so a "(Not Deployed)" landing page is caught here
    // rather than after a separate manual step the agent could skip.
    const deploy = options.port !== undefined ? await checkSpfxDeploy(exec.codespace, options.port, run) : undefined;
    return { ...base, status: "ready", runDir: exec.runDir, stdout: exec.stdout, failures: exec.failures, deploy };
  }
  return { ...base, status: "running", runDir: exec.runDir };
}

// Run rush and block until it reaches a terminal state, the CLI default so a
// hand-run rush build is awaited to its real exit code the same as running it in
// the codespace yourself. A watch is terminal once it is ready, so it returns
// while still serving; only a run-to-completion subcommand is polled to done.
export async function rushToCompletionVerb(
  options: { codespace?: string; cwd?: string; subcommand: string; to: string[]; port?: number; extra?: string[] },
  deps: ExecDeps = realExecDeps,
  waitDeps: WaitDeps = realWaitDeps,
  run: RemoteRunner = runInCodespace,
): Promise<RushResult> {
  const initial = await rushVerb(options, deps, run);
  if (initial.status !== "running") {
    return initial;
  }
  let collected = await waitVerb({ codespace: initial.codespace, runId: initial.runId }, waitDeps, run);
  while (collected.status === "running") {
    collected = await waitVerb({ codespace: collected.codespace, runId: collected.runId }, waitDeps, run);
  }
  return rushResultFromCollected(collected, initial);
}

// Re-wrap a collected exec result back into rush framing so a blocked rush run is
// presented exactly like one that finished inside the budget. The rush provenance
// rides along on the wait result from the run record, so the subcommand, mode,
// and port are recovered without re-deriving them from the argv, with the initial
// rush framing as the fallback.
function rushResultFromCollected(collected: ExecCompleted | ExecReady, initial: RushResult): RushResult {
  const base = {
    codespace: collected.codespace,
    runId: collected.runId,
    subcommand: collected.rush?.subcommand ?? initial.subcommand,
    mode: collected.rush?.mode ?? initial.mode,
    port: collected.rush?.port ?? initial.port,
  };
  if (collected.status === "completed") {
    return { ...base, status: "completed", exitCode: collected.exitCode, stdout: collected.stdout, stderr: collected.stderr, failures: collected.failures };
  }
  return { ...base, status: "ready", runDir: collected.runDir, stdout: collected.stdout, failures: collected.failures, deploy: collected.deploy };
}

// The exit code a finished or backgrounded run maps to for a shell caller. A
// real nonzero exit passes through. Beyond that, any result that surfaced build
// failures fails even when the process exited 0 or a watch only came up ready,
// so a failed sub-build can never be read as success by a script that only
// checks the exit code. Shared by the rush, exec, and wait faces so the resumed
// wait path enforces the same guarantee as the initial rush run.
function failureExitCode(status: string, exitCode: number | undefined, failures: FailureScan | undefined): number {
  if (status === "completed" && exitCode !== undefined && exitCode !== 0) {
    return exitCode;
  }
  if (failures !== undefined) {
    return 1;
  }
  return 0;
}

export function rushExitCode(result: RushResult): number {
  const base = failureExitCode(result.status, result.exitCode, result.failures);
  if (base !== 0) {
    return base;
  }
  return deployFailed(result.deploy) ? 1 : 0;
}

// A ready watch whose deploy assertion failed must fail a shell caller too, so a
// "(Not Deployed)" landing page blocks a scripted browser or curl handoff the same
// way a build failure does, even though the watch process itself never exits.
function deployFailed(deploy: SpfxDeployStatus | undefined): boolean {
  return deploy !== undefined && !deploy.deployed;
}

export type RemoteRunner = (codespace: string, remoteCommand: string) => Promise<RemoteResult>;

// curl exit codes that mean the dev server is not listening, as opposed to a
// missing curl or a setup error, which must surface their own stderr instead of
// being mislabeled as an unreachable port. 7 = connection refused, 28 = timeout.
const CURL_UNREACHABLE_EXITS = new Set([7, 28]);

// The deploy probe's bound. A localhost landing-page fetch answers in well under a
// second when the dev server is up, so this is generous headroom for the ssh and
// curl round trip. The rush ready paths reserve exactly this many seconds out of
// the async budget before reaching ready, so a single call that both reaches ready
// and verifies deploy still returns within the budget the client timeout is sized
// against rather than stacking the probe on top of a full readiness poll.
const DEPLOY_PROBE_TIMEOUT_SECONDS = 8;

// checkSpfxDeploy fetches the rush start landing page from inside the codespace
// and classifies its spfxDebugQueryString slot, the authoritative "did this
// scenario actually serve" signal. It is folded into the rush ready path rather
// than exposed as a separate verb, so a watch that reached ready but served
// "(Not Deployed)" is caught in the same call that started or resumed it. It
// returns a status instead of throwing so the rush and wait ready paths can fold
// it uniformly. A single fetch is enough because the SPFx serve plugin binds
// the port before the build even starts and the ready marker only fires after the
// build finishes, so at ready the port has been listening the whole time and there
// is no bind race to retry around. A localhost fetch has no working-directory
// dependency, so none is taken, which removes a bad-root failure mode.
export async function checkSpfxDeploy(
  codespace: string,
  port: number,
  run: RemoteRunner = runInCodespace,
): Promise<SpfxDeployStatus> {
  const url = `https://localhost:${port}/`;
  // -k: the dev server presents a local self-signed cert. -sS: no progress meter
  // but still print a transport error. -m: bound the fetch so an unreachable port
  // fails within the budget reserved for this probe.
  const result = await run(codespace, `curl -ksS -m ${DEPLOY_PROBE_TIMEOUT_SECONDS} ${shQuote(url)}`);
  if (result.exitCode === 0) {
    return classifySpfxDeploy(result.stdout);
  }
  const code = result.exitCode;
  if (code !== null && CURL_UNREACHABLE_EXITS.has(code)) {
    return {
      deployed: false,
      reachable: false,
      reason: `the dev server on port ${port} did not answer (curl exit ${code}); confirm a watch rush start is still serving on this port`,
    };
  }
  const detail = result.stderr.trim();
  return {
    deployed: false,
    reachable: false,
    reason: detail
      ? `the landing page could not be fetched (curl exit ${code ?? "unknown"}): ${detail}`
      : `the landing page could not be fetched (curl exit ${code ?? "unknown"}); confirm curl is on PATH in the codespace`,
  };
}

// The exit code for a plain exec or its later wait. A backgrounded run that is
// still running or only came up ready exits 0, but a result carrying failures
// fails, so a resumed `wait` on a watch whose sub-build failed is never read as
// healthy by a script even though the watch itself never exits nonzero.
export function execExitCode(result: ExecResult): number {
  const exitCode = result.status === "completed" ? result.exitCode : undefined;
  const failures = "failures" in result ? result.failures : undefined;
  const base = failureExitCode(result.status, exitCode, failures);
  if (base !== 0) {
    return base;
  }
  const deploy = "deploy" in result ? result.deploy : undefined;
  return deployFailed(deploy) ? 1 : 0;
}

export async function waitVerb(
  options: {
    codespace?: string;
    runId: string;
  },
  deps: WaitDeps = realWaitDeps,
  run: RemoteRunner = runInCodespace,
): Promise<ExecResult> {
  const tracked = getRun(options.runId);
  const codespace = resolveCodespace(options.codespace ?? tracked?.codespace);
  // A ready-gated run re-checks its persisted readiness condition rather than
  // only polling for completion, so a never-exiting dev server that came up
  // after the initial exec backgrounded still reports ready on a later wait.
  const ready = tracked?.readyWhen === undefined ? undefined : parseReadySpec(tracked.readyWhen);
  // A resumed rush watch with a port asserts its deploy state after reaching
  // ready, so reserve that probe's bound out of the readiness budget. The poll
  // plus the probe then fit one async round trip instead of stacking past it.
  const willProbe = ready !== undefined && tracked?.rush?.port !== undefined;
  const readyBudget = willProbe
    ? Math.max(1, DEFAULT_ASYNC_BUDGET_SECONDS - DEPLOY_PROBE_TIMEOUT_SECONDS)
    : DEFAULT_ASYNC_BUDGET_SECONDS;
  const outcome =
    ready === undefined
      ? await deps.wait(codespace, options.runId, DEFAULT_ASYNC_BUDGET_SECONDS)
      : await deps.readyWait(codespace, options.runId, readyBudget, ready);
  if (outcome.status === "missing") {
    removeRun(options.runId);
    throw new PlotholeError(
      `no active run ${options.runId}`,
      "The run already finished and was collected, or the id is wrong. Start a new `exec`.",
    );
  }
  if (outcome.status === "dead") {
    // The process is gone but never recorded a result, so there is nothing to
    // collect. The record is left in place so logs can still show the partial
    // output and kill can clear the run directory.
    throw new PlotholeError(
      `run ${options.runId} is no longer alive`,
      "Its process exited without recording a result, e.g. after a codespace suspend or resume. Tail its partial output with `plothole logs`, or clear it with `plothole kill`.",
    );
  }
  if (outcome.status === "done") {
    removeRun(options.runId);
    return { status: "completed", codespace, runId: options.runId, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr, failures: failuresIn(outcome.stdout, outcome.stderr), rush: tracked?.rush };
  }
  if (outcome.status === "ready") {
    // The run is up but still running, so it stays tracked for a later collect.
    // Rush provenance is carried through so the resumed path keeps the same
    // forward hint the initial rush run emitted. A cold rush build exceeds the
    // async budget and reaches ready here on a resumed wait rather than in the
    // initial rushVerb call, so this is where a backgrounded watch's deploy state
    // gets asserted, keeping the deploy gate on the common path instead of only
    // the rare inline-ready path.
    const deploy =
      tracked?.rush?.port !== undefined ? await checkSpfxDeploy(codespace, tracked.rush.port, run) : undefined;
    return { status: "ready", codespace, runId: options.runId, runDir: codespaceRunDir(options.runId), stdout: outcome.stdout, failures: failuresIn(outcome.stdout), rush: tracked?.rush, deploy };
  }
  return { status: "running", codespace, runId: options.runId, runDir: codespaceRunDir(options.runId), rush: tracked?.rush };
}

export interface LogsResult {
  codespace: string;
  runId: string;
  status: "running" | "done" | "dead";
  stdout: string;
  stderr: string;
  exitCode?: number;
  failures?: FailureScan;
  // Rush provenance rehydrated from the run record so a resumed tail keeps the
  // subcommand and port, matching what the initial rush run reported.
  rush?: RushRunMeta;
}

// logs tails a backgrounded exec without collecting it, so the agent can watch
// a long build's progress and read its log markers, then decide to wait or kill.
// It never removes the run, so a later wait still recovers the full result.
export async function logsVerb(
  options: { codespace?: string; runId: string; lines?: number },
  deps: LogsDeps = realLogsDeps,
): Promise<LogsResult> {
  const tracked = getRun(options.runId);
  const codespace = resolveCodespace(options.codespace ?? tracked?.codespace);
  const outcome = await deps.logs(codespace, options.runId, options.lines);
  if (outcome.status === "missing") {
    throw new PlotholeError(
      `no run ${options.runId} to tail`,
      "The run already finished and was collected, or the id is wrong. Run `plothole runs` to list tracked runs.",
    );
  }
  return {
    codespace,
    runId: options.runId,
    status: outcome.status,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    failures: failuresIn(outcome.stdout, outcome.stderr),
    rush: tracked?.rush,
  };
}

export interface ForwardResult {
  action: "start" | "list" | "stop";
  forwards: ForwardView[];
}

// forward bridges a codespace TCP port to a host port so host tools can reach a
// codespace service. Unlike every other verb this runs on the host; start needs
// a codespace, while list and stop operate purely on the host's tracked records.
export async function forwardVerb(options: {
  codespace?: string;
  port?: number;
  localPort?: number;
  list?: boolean;
  stop?: number;
}): Promise<ForwardResult> {
  if (options.list === true) {
    return { action: "list", forwards: listForwards() };
  }
  if (options.stop !== undefined) {
    return { action: "stop", forwards: stopForward(options.stop) };
  }
  if (options.port === undefined) {
    throw new PlotholeError(
      "forward requires a port",
      "Pass the codespace port to forward, e.g. `plothole forward 35565`.",
    );
  }
  const codespace = resolveCodespace(options.codespace);
  const localPort = options.localPort ?? options.port;
  const outcome = await startForward({ codespace, codespacePort: options.port, localPort });
  return { action: "start", forwards: [{ ...outcome.record, alive: true, listening: outcome.listening }] };
}

export interface RunsResult {
  runs: RunRecord[];
}

export interface KillResult {
  codespace: string;
  runId: string;
  status: KillOutcome;
}

// kill stops a backgrounded exec and its subprocess tree in the codespace, then
// drops the host run record. Unlike clean, which only prunes records for runs
// that already finished, kill signals a live process to cancel a runaway build.
export async function killVerb(options: { codespace?: string; runId: string }): Promise<KillResult> {
  const tracked = getRun(options.runId);
  const codespace = resolveCodespace(options.codespace ?? tracked?.codespace);
  const status = await killInCodespace(codespace, options.runId);
  // The remote process and its run directory are gone, so drop the host record
  // too. removeRun is a no-op when the run was never tracked.
  removeRun(options.runId);
  return { codespace, runId: options.runId, status };
}

export function runsVerb(): RunsResult {
  return { runs: listRuns() };
}

// clean prunes host run records for backgrounded execs that already finished or
// vanished. Only waitVerb prunes on the happy path, so a run that is never
// waited on would otherwise linger in `runs` forever. Each tracked run is polled
// with a minimal budget; a still-running exec is left untouched so cleanup can
// never discard live work, and an unreachable codespace keeps its record so the
// run is not silently lost.
const CLEAN_POLL_SECONDS = 1;

export interface CleanOutcome {
  runId: string;
  codespace: string;
  disposition: "removed" | "running" | "error";
  reason?: string;
}

export interface CleanResult {
  cleaned: CleanOutcome[];
}

export async function cleanVerb(
  poll: (codespace: string, runId: string) => Promise<AsyncRunOutcome> = (codespace, runId) =>
    runAsyncWait(codespace, runId, CLEAN_POLL_SECONDS),
): Promise<CleanResult> {
  const cleaned: CleanOutcome[] = [];
  for (const run of listRuns()) {
    try {
      const outcome = await poll(run.codespace, run.runId);
      if (outcome.status === "running") {
        cleaned.push({ runId: run.runId, codespace: run.codespace, disposition: "running" });
        continue;
      }
      removeRun(run.runId);
      cleaned.push({ runId: run.runId, codespace: run.codespace, disposition: "removed", reason: outcome.status });
    } catch (err) {
      cleaned.push({
        runId: run.runId,
        codespace: run.codespace,
        disposition: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { cleaned };
}

export interface ReadResult {
  codespace: string;
  path: string;
  content: string;
}

export async function readVerb(options: {
  codespace?: string;
  cwd?: string;
  path: string;
  range?: ReadRange;
}): Promise<ReadResult> {
  const codespace = resolveCodespace(options.codespace);
  const cwd = resolveCwd(codespace, options.cwd);
  const result = await runInCodespace(codespace, buildReadCommand(options.path, options.range), { cwd });
  if (result.exitCode !== 0) {
    throw new PlotholeError(`read failed: ${options.path}`, result.stderr.trim() || "file not found or not readable");
  }
  return { codespace, path: options.path, content: result.stdout };
}

export interface SearchResult {
  codespace: string;
  matched: boolean;
  output: string;
}

export async function searchVerb(options: {
  codespace?: string;
  cwd?: string;
  query: string;
  search?: SearchOptions;
}): Promise<SearchResult> {
  const codespace = resolveCodespace(options.codespace);
  const cwd = resolveCwd(codespace, options.cwd);
  const result = await runInCodespace(codespace, buildSearchCommand(options.query, options.search ?? {}), {
    cwd,
  });
  // rg exits 0 with matches, 1 with no matches, 2+ on error.
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new PlotholeError("search failed", result.stderr.trim() || "ripgrep reported an error");
  }
  return { codespace, matched: result.exitCode === 0, output: result.stdout };
}

export interface EditResult {
  codespace: string;
  path: string;
  replaced: number;
}

export async function editVerb(options: {
  codespace?: string;
  cwd?: string;
  path: string;
  oldString: string;
  newString: string;
}): Promise<EditResult> {
  if (options.oldString.length === 0) {
    throw new PlotholeError("edit requires a non-empty old string", "Provide the exact text to replace via --old.");
  }
  const codespace = resolveCodespace(options.codespace);
  const cwd = resolveCwd(codespace, options.cwd);
  const result = await runInCodespace(codespace, buildEditCommand(options.path, options.oldString, options.newString), {
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new PlotholeError(
      `edit failed: ${options.path}`,
      result.stderr.trim() || "the old string must occur exactly once in the file",
    );
  }
  return { codespace, path: options.path, replaced: 1 };
}

export interface EnvResult {
  codespace: string;
  info: Record<string, string>;
}

export async function envVerb(options: { codespace?: string; cwd?: string }): Promise<EnvResult> {
  const codespace = resolveCodespace(options.codespace);
  const cwd = resolveCwd(codespace, options.cwd);
  const includeInstallState = cwd !== undefined;
  const result = await runInCodespace(codespace, buildEnvProbe(includeInstallState), { cwd });
  const info: Record<string, string> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) {
      info[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return { codespace, info };
}

// Session inspection plus codespace selection and per-codespace root config,
// shared so the CLI and MCP faces stay identical. --ensure verifies a codespace
// exists before persisting it active, so a typo fails here instead of as a
// confusing connection error on the next verb. A root is validated against the
// codespace before it is saved, so scoping never silently points every verb at a
// directory that does not exist.
export interface SessionResult {
  active: string | null;
  root?: string | null;
  state?: string;
  repository?: string;
  codespaces?: CodespaceInfo[];
}

async function applyRootChange(
  codespace: string,
  options: { setRoot?: string; clearRoot?: boolean },
): Promise<void> {
  if (options.setRoot !== undefined && options.clearRoot === true) {
    throw new PlotholeError(
      "set a root or clear it, not both",
      "Pass --set-root <path> to scope the codespace, or --clear-root to unset it.",
    );
  }
  if (options.setRoot !== undefined) {
    const root = options.setRoot;
    const check = await runInCodespace(codespace, `test -d ${shQuote(root)}`);
    if (check.exitCode !== 0) {
      throw new PlotholeError(
        `root not found in codespace: ${root}`,
        `${root} is not a directory in ${codespace}. Pass a path that exists, e.g. /workspaces/<repo>.`,
      );
    }
    setRoot(codespace, root);
  }
  if (options.clearRoot === true) {
    clearRoot(codespace);
  }
}

export async function sessionVerb(options: {
  ensure?: string;
  codespace?: string;
  setRoot?: string;
  clearRoot?: boolean;
}): Promise<SessionResult> {
  const codespaces = await listCodespaces();
  if (options.ensure !== undefined) {
    const match = codespaces.find((codespace) => codespace.name === options.ensure);
    if (match === undefined) {
      throw new PlotholeError(
        `no codespace named ${options.ensure}`,
        "Run `plothole session` to list the codespaces visible to the active account.",
      );
    }
    setActiveCodespace(match.name);
    await applyRootChange(match.name, options);
    return { active: match.name, state: match.state, repository: match.repository, root: getRoot(match.name) ?? null };
  }
  if (options.setRoot !== undefined || options.clearRoot === true) {
    const target = resolveCodespace(options.codespace);
    await applyRootChange(target, options);
    return { active: getActiveCodespace() ?? null, root: getRoot(target) ?? null };
  }
  const active = getActiveCodespace() ?? null;
  return { active, root: active === null ? null : getRoot(active) ?? null, codespaces };
}
