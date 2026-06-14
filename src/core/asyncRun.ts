// Markers, result types, and the pure parser for the async exec path. The async
// path does NOT reuse the sync exit-code sentinel: a detached command writes its
// real exit code to a file in the codespace and the host recovers stdout/stderr
// as base64 over a clean marker stream. Keeping the markers and the parser here
// lets remote.ts build the scripts and transport.ts run them without either one
// owning the wire format alone.

// The Copilot CLI MCP client abandons a tool call near 60s. The in-codespace
// poll is hardcoded under that so a slow build returns a running handle while
// the collect round trip and base64 transfer still land inside the window. Fast
// commands complete within the budget and return inline.
export const DEFAULT_ASYNC_BUDGET_SECONDS = 45;

export const ASYNC_STATUS_PREFIX = "__PLOTHOLE_ASYNC_STATUS__=";
export const ASYNC_RC_PREFIX = "__PLOTHOLE_ASYNC_RC__=";
export const ASYNC_OUT_PREFIX = "__PLOTHOLE_ASYNC_OUT__=";
export const ASYNC_ERR_PREFIX = "__PLOTHOLE_ASYNC_ERR__=";
export const KILL_STATUS_PREFIX = "__PLOTHOLE_KILL__=";
export const LOGS_STATUS_PREFIX = "__PLOTHOLE_LOGS__=";

export type AsyncRunOutcome =
  | { status: "done"; exitCode: number; stdout: string; stderr: string }
  | { status: "ready"; stdout: string }
  | { status: "running" }
  | { status: "dead" }
  | { status: "missing" }
  | { status: "unknown"; raw: string };

function matchLine(raw: string, prefix: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }
  return undefined;
}

function decodeB64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

// Pure: turns the marker stream a codespace emitted into a structured outcome.
// "unknown" means no status marker was found, which the caller treats as a
// protocol or reachability failure rather than a run state.
export function parseAsyncOutput(raw: string): AsyncRunOutcome {
  const status = matchLine(raw, ASYNC_STATUS_PREFIX);
  if (status === "running") {
    return { status: "running" };
  }
  // A run whose process is gone but never wrote an rc is dead, not running: the
  // codespace was suspended or the process was killed out from under us. Reporting
  // it honestly is what lets the host stop trusting a stale "running" marker.
  if (status === "dead") {
    return { status: "dead" };
  }
  if (status === "missing") {
    return { status: "missing" };
  }
  // A ready run met its --ready-when condition before it finished. The process
  // is still going; the host gets a snapshot of stdout so far and keeps the run.
  if (status === "ready") {
    return { status: "ready", stdout: decodeB64(matchLine(raw, ASYNC_OUT_PREFIX) ?? "") };
  }
  if (status === "done") {
    const rc = matchLine(raw, ASYNC_RC_PREFIX);
    if (rc === undefined || rc.trim() === "" || Number.isNaN(Number(rc))) {
      return { status: "unknown", raw };
    }
    return {
      status: "done",
      exitCode: Number(rc),
      stdout: decodeB64(matchLine(raw, ASYNC_OUT_PREFIX) ?? ""),
      stderr: decodeB64(matchLine(raw, ASYNC_ERR_PREFIX) ?? ""),
    };
  }
  return { status: "unknown", raw };
}

export type LogsOutcome =
  | { status: "running" | "done" | "dead"; stdout: string; stderr: string; exitCode?: number }
  | { status: "missing" }
  | { status: "unknown"; raw: string };

// Pure: reads the non-destructive logs marker stream. Unlike the async wait
// stream this never carries a "collected" semantics; the run directory is left
// intact so a later wait can still recover the full result.
export function parseLogsOutput(raw: string): LogsOutcome {
  const status = matchLine(raw, LOGS_STATUS_PREFIX);
  if (status === "missing") {
    return { status: "missing" };
  }
  if (status === "running" || status === "done" || status === "dead") {
    const stdout = decodeB64(matchLine(raw, ASYNC_OUT_PREFIX) ?? "");
    const stderr = decodeB64(matchLine(raw, ASYNC_ERR_PREFIX) ?? "");
    const rc = matchLine(raw, ASYNC_RC_PREFIX);
    const exitCode = rc !== undefined && rc.trim() !== "" && !Number.isNaN(Number(rc)) ? Number(rc) : undefined;
    return { status, stdout, stderr, exitCode };
  }
  return { status: "unknown", raw };
}

export type KillOutcome = "killed" | "not-running" | "missing" | "unknown";

// Pure: reads the kill marker a codespace emits after a kill attempt. "unknown"
// means no marker was found, which the caller treats as a reachability or
// protocol failure rather than a confirmed stop.
export function parseKillOutput(raw: string): KillOutcome {
  const status = matchLine(raw, KILL_STATUS_PREFIX);
  if (status === "killed" || status === "not-running" || status === "missing") {
    return status;
  }
  return "unknown";
}
