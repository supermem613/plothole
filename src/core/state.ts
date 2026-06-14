import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Active-codespace selection lives in a state file rather than an environment
// variable so a host agent can target one codespace without repeating --host on
// every call. homedir() is used (not process.env) so the test runner's HOME
// sandbox keeps tests off the developer's real state.

export interface PlotholeState {
  activeCodespace?: string;
  runs?: RunRecord[];
  forwards?: ForwardRecord[];
  roots?: Record<string, string>;
}

// A backgrounded exec the host is still tracking. Persisted to disk so `wait`
// can resolve the codespace and recover the run even after the host CLI or the
// Copilot session restarts. Removed once the run is collected or found gone.
export interface RunRecord {
  runId: string;
  codespace: string;
  command: string;
  cwd?: string;
  startedAt: string;
  // The --ready-when spec a backgrounded exec was launched with, persisted so a
  // later wait re-evaluates the same readiness condition instead of only polling
  // for completion. Absent for a run that had no readiness gate.
  readyWhen?: string;
  // Rush provenance for a backgrounded rush run, persisted so a later wait or
  // logs can present the same forward hint instead of degrading to a generic
  // exec payload that has lost the port. Absent for a plain exec.
  rush?: RushRunMeta;
}

// The rush-specific framing of a backgrounded run: which subcommand it ran,
// whether it is a long-lived watch or a one-shot build, and the port a watch
// serves on. Persisted with the run so the resumed path can rebuild the
// forward hint the initial rush result carried.
export interface RushRunMeta {
  subcommand: string;
  mode: "watch" | "once";
  port?: number;
}

// A host-side `gh codespace ports forward` process bridging a codespace TCP port
// to a host port. Persisted so the host can list and stop a forward across CLI
// invocations; the forward process itself is detached and outlives plothole.
export interface ForwardRecord {
  codespace: string;
  codespacePort: number;
  localPort: number;
  pid: number;
  startedAt: string;
}

export function stateDir(): string {
  return join(homedir(), ".plothole");
}

export function statePath(): string {
  return join(stateDir(), "state.json");
}

export function readState(): PlotholeState {
  const path = statePath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlotholeState;
  } catch {
    return {};
  }
}

export function writeState(state: PlotholeState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function getActiveCodespace(): string | undefined {
  return readState().activeCodespace;
}

export function setActiveCodespace(name: string): void {
  const state = readState();
  state.activeCodespace = name;
  writeState(state);
}

// The workspace root scopes a codespace's verbs. It is persisted per codespace,
// never hardcoded, so the tool stays generic: with no root set, verbs run in the
// bare login directory exactly as before. Set one with `session --set-root` and
// every verb defaults its working directory to it.
export function getRoot(codespace: string): string | undefined {
  return readState().roots?.[codespace];
}

export function setRoot(codespace: string, root: string): void {
  const state = readState();
  const roots = state.roots ?? {};
  roots[codespace] = root;
  state.roots = roots;
  writeState(state);
}

export function clearRoot(codespace: string): void {
  const state = readState();
  if (state.roots === undefined) {
    return;
  }
  delete state.roots[codespace];
  writeState(state);
}

export function recordRun(run: RunRecord): void {
  const state = readState();
  const runs = (state.runs ?? []).filter((existing) => existing.runId !== run.runId);
  runs.push(run);
  state.runs = runs;
  writeState(state);
}

export function getRun(runId: string): RunRecord | undefined {
  return (readState().runs ?? []).find((run) => run.runId === runId);
}

// Attach rush provenance to an already-recorded run. recordRun writes the run
// before rushVerb knows its rush framing, so this patches it in place. A no-op
// for an unknown run id so a completed rush that was never tracked is harmless.
export function setRunRush(runId: string, rush: RushRunMeta): void {
  const state = readState();
  const run = (state.runs ?? []).find((existing) => existing.runId === runId);
  if (run === undefined) {
    return;
  }
  run.rush = rush;
  writeState(state);
}

export function removeRun(runId: string): void {
  const state = readState();
  if (state.runs === undefined) {
    return;
  }
  state.runs = state.runs.filter((run) => run.runId !== runId);
  writeState(state);
}

export function listRuns(): RunRecord[] {
  return readState().runs ?? [];
}

export function addForward(forward: ForwardRecord): void {
  const state = readState();
  const forwards = (state.forwards ?? []).filter((existing) => existing.localPort !== forward.localPort);
  forwards.push(forward);
  state.forwards = forwards;
  writeState(state);
}

export function listForwardRecords(): ForwardRecord[] {
  return readState().forwards ?? [];
}

export function removeForward(localPort: number): void {
  const state = readState();
  if (state.forwards === undefined) {
    return;
  }
  state.forwards = state.forwards.filter((forward) => forward.localPort !== localPort);
  writeState(state);
}

export function outputDir(): string {
  return join(tmpdir(), "plothole");
}
