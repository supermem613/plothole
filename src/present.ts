import { backIfLarge, READ_INLINE_LIMIT, type BackedOutput } from "./core/output.js";
import type { SpfxDeployStatus } from "./core/spfxDeploy.js";
import type {
  CleanResult,
  EditResult,
  EnvResult,
  ExecResult,
  ForwardResult,
  KillResult,
  LogsResult,
  ReadResult,
  RunsResult,
  RushResult,
  SearchResult,
} from "./core/verbs.js";

// Shared shaping of verb results into the data payload both faces emit. Large
// stdout, stderr, and file content are file-backed so a single noisy build
// cannot flood the agent's context. The CLI and MCP face must present identical
// data, so this mapping lives here rather than being duplicated in either face.
// A field is either an inline string or a { file, bytes } pointer, mirroring the
// file-backed result contract callers already know from atrium.

type Field = string | { file: string; bytes: number };

function field(output: BackedOutput): Field {
  if (output.fileBacked === true && output.file !== undefined) {
    return { file: output.file, bytes: output.bytes };
  }
  return output.inline ?? "";
}

// The hint a ready watch shows so the next move (bridge the port to the host,
// then point a browser or curl at it) is spelled out rather than rediscovered.
// Shared by presentRush and presentExec so the initial rush run and a resumed
// wait that rehydrated the same rush provenance emit an identical hint.
function rushReadyHint(subcommand: string, runId: string, port: number | undefined): string {
  const forward =
    port === undefined
      ? `it stays running in the codespace, rebuilding on changes`
      : `forward it to the host with \`plothole forward ${port}\`, then browse the dev server at localhost:${port}`;
  return `${subcommand} is ready and still running; ${forward}. collect it with \`plothole wait ${runId}\` or stop it with \`plothole kill ${runId}\``;
}

// The hint a ready watch shows once its deploy state is known. A deployed watch
// gets the forward-then-browse hint. A watch that served "(Not Deployed)" or no
// slot at all is a build and deploy closure problem, so its hint points at the
// --to closure. A watch whose landing page could not be fetched at all is a
// transport problem, not a closure one, so its hint points at the watch and the
// port instead of sending the agent to widen selectors that may be correct.
function readyDeployHint(
  subcommand: string,
  runId: string,
  port: number | undefined,
  deploy: SpfxDeployStatus | undefined,
): string {
  if (deploy !== undefined && !deploy.deployed) {
    if (deploy.reachable === false) {
      return `the watch reported ready but its dev server did not answer: ${deploy.reason}. this is a transport problem, not a build closure one; confirm the watch is still serving on port ${port}, then rerun \`plothole wait ${runId}\` to re-check, or stop it with \`plothole kill ${runId}\``;
    }
    return `the watch is up but the scenario did not deploy: ${deploy.reason}. this is a build and deploy closure failure, not an auth or handoff problem; widen the rush --to closure to include every project the scenario needs, then rerun. stop this watch with \`plothole kill ${runId}\``;
  }
  return rushReadyHint(subcommand, runId, port);
}

export function presentExec(result: ExecResult): Record<string, unknown> {
  if (result.status === "running") {
    return {
      status: "running",
      codespace: result.codespace,
      runId: result.runId,
      runDir: result.runDir,
      ...(result.rush ? { subcommand: result.rush.subcommand, mode: result.rush.mode, ...(result.rush.port !== undefined ? { port: result.rush.port } : {}) } : {}),
      hint: `still running; tail it with \`plothole logs ${result.runId}\`, collect it with \`plothole wait ${result.runId}\`, or stop it with \`plothole kill ${result.runId}\``,
    };
  }
  if (result.status === "ready") {
    // A resumed rush wait rehydrates rush provenance, so its hint becomes the
    // same forward hint the initial rush run emitted instead of the generic
    // tail-or-collect hint a plain ready exec shows. When the resumed run is a
    // rush watch with a port, its deploy state was asserted on this path, so the
    // hint reflects whether the scenario actually served.
    const hint = result.rush
      ? readyDeployHint(result.rush.subcommand, result.runId, result.rush.port, result.deploy)
      : `ready condition met; the process is still running. tail it with \`plothole logs ${result.runId}\`, collect it with \`plothole wait ${result.runId}\`, or stop it with \`plothole kill ${result.runId}\``;
    return {
      status: "ready",
      codespace: result.codespace,
      runId: result.runId,
      runDir: result.runDir,
      ...(result.rush ? { subcommand: result.rush.subcommand, mode: result.rush.mode, ...(result.rush.port !== undefined ? { port: result.rush.port } : {}) } : {}),
      stdout: field(backIfLarge(result.stdout, "exec-stdout")),
      ...(result.failures ? { failures: result.failures } : {}),
      ...(result.deploy ? { deploy: result.deploy } : {}),
      hint,
    };
  }
  return {
    status: "completed",
    codespace: result.codespace,
    runId: result.runId,
    ...(result.rush ? { subcommand: result.rush.subcommand, mode: result.rush.mode, ...(result.rush.port !== undefined ? { port: result.rush.port } : {}) } : {}),
    exitCode: result.exitCode,
    stdout: field(backIfLarge(result.stdout, "exec-stdout")),
    stderr: field(backIfLarge(result.stderr, "exec-stderr")),
    ...(result.failures ? { failures: result.failures } : {}),
  };
}

export function presentLogs(result: LogsResult): Record<string, unknown> {
  return {
    codespace: result.codespace,
    runId: result.runId,
    status: result.status,
    ...(result.rush ? { subcommand: result.rush.subcommand, mode: result.rush.mode, ...(result.rush.port !== undefined ? { port: result.rush.port } : {}) } : {}),
    exitCode: result.exitCode,
    stdout: field(backIfLarge(result.stdout, "logs-stdout")),
    stderr: field(backIfLarge(result.stderr, "logs-stderr")),
    ...(result.failures ? { failures: result.failures } : {}),
  };
}

// A rush result keeps the rush-specific framing (subcommand, watch vs once,
// port) and adds a forward hint for a watch with a port, so the agent's next
// move (bridge the port to the host, then point a browser or curl at it) is
// spelled out rather than rediscovered. failures are surfaced exactly as exec
// does so a watch that came up while a sub-build failed is never read as healthy.
// A ready watch also carries its asserted deploy state, so a "(Not Deployed)"
// scenario is surfaced as a NO-GO in the same payload that reported ready.
export function presentRush(result: RushResult): Record<string, unknown> {
  const common = {
    status: result.status,
    codespace: result.codespace,
    runId: result.runId,
    subcommand: result.subcommand,
    mode: result.mode,
    ...(result.port !== undefined ? { port: result.port } : {}),
    ...(result.failures ? { failures: result.failures } : {}),
  };
  if (result.status === "running") {
    return {
      ...common,
      runDir: result.runDir,
      hint: `still building; tail it with \`plothole logs ${result.runId}\`, collect it with \`plothole wait ${result.runId}\`, or stop it with \`plothole kill ${result.runId}\``,
    };
  }
  if (result.status === "ready") {
    return {
      ...common,
      runDir: result.runDir,
      stdout: field(backIfLarge(result.stdout ?? "", "rush-stdout")),
      ...(result.deploy ? { deploy: result.deploy } : {}),
      hint: readyDeployHint(result.subcommand, result.runId, result.port, result.deploy),
    };
  }
  return {
    ...common,
    exitCode: result.exitCode,
    stdout: field(backIfLarge(result.stdout ?? "", "rush-stdout")),
    stderr: field(backIfLarge(result.stderr ?? "", "rush-stderr")),
  };
}

export function presentForward(result: ForwardResult): Record<string, unknown> {
  return { action: result.action, forwards: result.forwards };
}

export function presentRuns(result: RunsResult): Record<string, unknown> {
  return { runs: result.runs };
}

export function presentClean(result: CleanResult): Record<string, unknown> {
  const removed = result.cleaned.filter((run) => run.disposition === "removed").length;
  const kept = result.cleaned.length - removed;
  return { cleaned: result.cleaned, removed, kept };
}

export function presentKill(result: KillResult): Record<string, unknown> {
  return { codespace: result.codespace, runId: result.runId, status: result.status };
}

export function presentRead(result: ReadResult): Record<string, unknown> {
  return {
    codespace: result.codespace,
    path: result.path,
    content: field(backIfLarge(result.content, "read", READ_INLINE_LIMIT)),
  };
}

export function presentSearch(result: SearchResult): Record<string, unknown> {
  return {
    codespace: result.codespace,
    matched: result.matched,
    output: field(backIfLarge(result.output, "search")),
  };
}

export function presentEdit(result: EditResult): Record<string, unknown> {
  return { codespace: result.codespace, path: result.path, replaced: result.replaced };
}

export function presentEnv(result: EnvResult): Record<string, unknown> {
  return { codespace: result.codespace, info: result.info };
}
