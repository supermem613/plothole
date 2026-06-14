import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolveGh } from "./gh.js";
import { PlotholeError } from "./errors.js";
import { addForward, listForwardRecords, removeForward, type ForwardRecord } from "./state.js";

// forward is the one verb that runs on the HOST, not inside the codespace. It
// wraps `gh codespace ports forward` so a host tool (a browser or curl) can
// reach a service running in the codespace. The forward process is detached and
// outlives plothole; the host tracks its pid so it can be listed and stopped.

const PROBE_ATTEMPTS = 20;
const PROBE_INTERVAL_MS = 750;
const PROBE_CONNECT_TIMEOUT_MS = 1000;

export interface ForwardView extends ForwardRecord {
  alive: boolean;
  listening?: boolean;
}

export interface ForwardStartOutcome {
  record: ForwardRecord;
  listening: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 tests for the process without affecting it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probeOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Poll the host port until something accepts a connection or the attempts run
// out. This is bounded condition polling, not a blind wait: each attempt is a
// real readiness check and the interval only spaces the checks. A refused
// connection returns immediately, so the interval keeps the loop from spinning.
async function pollHostPort(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (await probeOnce(port)) {
      return true;
    }
    await wait(PROBE_INTERVAL_MS);
  }
  return false;
}

export async function startForward(options: {
  codespace: string;
  codespacePort: number;
  localPort: number;
}): Promise<ForwardStartOutcome> {
  const gh = await resolveGh();
  // gh's forward syntax is <localPort>:<codespacePort>. Detached with ignored
  // stdio and unref so it survives this CLI invocation and the Copilot session.
  const child = spawn(
    gh,
    ["codespace", "ports", "forward", `${options.localPort}:${options.codespacePort}`, "-c", options.codespace],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  if (child.pid === undefined) {
    throw new PlotholeError(
      "could not start gh port forward",
      "Confirm the GitHub CLI is installed and that the active account owns the codespace.",
    );
  }
  child.unref();
  const record: ForwardRecord = {
    codespace: options.codespace,
    codespacePort: options.codespacePort,
    localPort: options.localPort,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  };
  addForward(record);
  const listening = await pollHostPort(options.localPort);
  return { record, listening };
}

export function listForwards(): ForwardView[] {
  return listForwardRecords().map((record) => ({ ...record, alive: pidAlive(record.pid) }));
}

// Stop every forward bound to the given host port. A dead pid is treated as
// already stopped, so this is idempotent and always clears the host record.
export function stopForward(localPort: number): ForwardView[] {
  const stopped = listForwardRecords().filter((record) => record.localPort === localPort);
  if (stopped.length === 0) {
    throw new PlotholeError(
      `no forward on host port ${localPort}`,
      "Run `plothole forward --list` to see the active forwards.",
    );
  }
  const views: ForwardView[] = [];
  for (const record of stopped) {
    let alive = pidAlive(record.pid);
    if (alive) {
      try {
        process.kill(record.pid);
        alive = false;
      } catch {
        alive = pidAlive(record.pid);
      }
    }
    removeForward(record.localPort);
    views.push({ ...record, alive });
  }
  return views;
}
