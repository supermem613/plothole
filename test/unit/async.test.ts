import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildAsyncExec,
  buildAsyncExecReady,
  buildAsyncReadyWait,
  buildAsyncWait,
  buildLogsCommand,
  parseReadySpec,
} from "../../src/core/remote.js";
import {
  ASYNC_ERR_PREFIX,
  ASYNC_OUT_PREFIX,
  ASYNC_RC_PREFIX,
  ASYNC_STATUS_PREFIX,
  LOGS_STATUS_PREFIX,
  parseAsyncOutput,
  parseLogsOutput,
} from "../../src/core/asyncRun.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";

function extractRunner(script: string): string {
  const match = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script);
  assert.ok(match, "launcher must embed the runner as base64");
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("buildAsyncExec", () => {
  it("launches the command detached under the run directory", () => {
    const script = buildAsyncExec(RUN_ID, "rush build", { cwd: "/workspaces/app", budgetSeconds: 40 });
    assert.ok(script.includes(`RUN_DIR="$HOME/.plothole/runs/${RUN_ID}"`));
    assert.ok(script.includes('mkdir -p "$RUN_DIR"'));
    assert.ok(script.includes('nohup bash -l "$RUN_DIR/run.sh" "$RUN_DIR" > "$RUN_DIR/out" 2> "$RUN_DIR/err" < /dev/null &'));
    assert.ok(script.includes('echo $! > "$RUN_DIR/pid"'));
  });

  it("launches the runner under a login shell so it inherits the Codespaces environment", () => {
    // The detached command is what runs a real build, deploy, or test. gh cs ssh
    // gives a non-login shell whose env lacks GITHUB_USER, CODESPACE_NAME, and
    // the auth tokens the codespaces profile injects on login. Launching run.sh
    // with bash -l sources that profile so the command sees the same environment
    // the user's terminal does.
    const script = buildAsyncExec(RUN_ID, "rush start", { cwd: "/workspaces/app", budgetSeconds: 40 });
    assert.ok(script.includes('nohup bash -l "$RUN_DIR/run.sh"'), "the runner must launch under a login shell");
    assert.ok(!/nohup bash "\$RUN_DIR\/run\.sh"/.test(script), "must not launch the runner in a non-login shell");
  });

  it("carries the command and cwd only inside the base64 runner, never in the launcher shell", () => {
    const script = buildAsyncExec(RUN_ID, "rush build", { cwd: "/workspaces/app", budgetSeconds: 40 });
    const runner = extractRunner(script);
    assert.ok(runner.includes("cd /workspaces/app && rush build"));
    assert.ok(runner.includes('echo $? > "$1/rc"'));
    // The raw command must not leak into the launcher script itself.
    assert.ok(!script.includes("cd /workspaces/app && rush build"));
  });

  it("omits the cd when no cwd is given", () => {
    const runner = extractRunner(buildAsyncExec(RUN_ID, "ls", { budgetSeconds: 40 }));
    assert.ok(runner.startsWith("ls\n"));
    assert.ok(!runner.includes("cd "));
  });

  it("appends the wait block so a fast command returns inline", () => {
    const script = buildAsyncExec(RUN_ID, "true", { budgetSeconds: 40 });
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}done`));
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}running`));
  });

  it("rejects an unsafe run id", () => {
    assert.throws(() => buildAsyncExec("../etc", "ls", { budgetSeconds: 40 }), /unsafe run id/);
  });
});

describe("buildAsyncWait", () => {
  it("polls for the rc file up to the budget and emits the collect markers", () => {
    const script = buildAsyncWait(RUN_ID, 12);
    assert.ok(script.includes(`RUN_DIR="$HOME/.plothole/runs/${RUN_ID}"`));
    assert.ok(script.includes('while [ "$i" -lt 12 ]; do'));
    assert.ok(script.includes('[ -f "$RUN_DIR/rc" ] && break'));
    assert.ok(script.includes("sleep 1"));
    assert.ok(script.includes('base64 -w0 "$RUN_DIR/out"'));
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}missing`));
    assert.ok(script.includes('rm -rf "$RUN_DIR"'));
  });

  it("does not launch anything", () => {
    const script = buildAsyncWait(RUN_ID, 12);
    assert.ok(!script.includes("nohup"));
    assert.ok(!script.includes("base64 -d"));
  });

  it("clamps a fractional or sub-second budget to at least one second", () => {
    assert.ok(buildAsyncWait(RUN_ID, 0.4).includes('while [ "$i" -lt 1 ]; do'));
    assert.ok(buildAsyncWait(RUN_ID, 7.9).includes('while [ "$i" -lt 7 ]; do'));
  });

  it("rejects a non-finite budget", () => {
    assert.throws(() => buildAsyncWait(RUN_ID, Number.POSITIVE_INFINITY), /invalid budget/);
  });
});

describe("parseAsyncOutput", () => {
  it("decodes a completed run", () => {
    const out = Buffer.from("build ok\n", "utf8").toString("base64");
    const err = Buffer.from("a warning\n", "utf8").toString("base64");
    const raw = [
      `${ASYNC_STATUS_PREFIX}done`,
      `${ASYNC_RC_PREFIX}0`,
      `${ASYNC_OUT_PREFIX}${out}`,
      `${ASYNC_ERR_PREFIX}${err}`,
    ].join("\n");
    const result = parseAsyncOutput(raw);
    assert.deepEqual(result, { status: "done", exitCode: 0, stdout: "build ok\n", stderr: "a warning\n" });
  });

  it("recovers a nonzero exit code", () => {
    const raw = `${ASYNC_STATUS_PREFIX}done\n${ASYNC_RC_PREFIX}7\n${ASYNC_OUT_PREFIX}\n${ASYNC_ERR_PREFIX}`;
    const result = parseAsyncOutput(raw);
    assert.equal(result.status, "done");
    assert.equal((result as { exitCode: number }).exitCode, 7);
  });

  it("handles empty stdout and stderr", () => {
    const raw = `${ASYNC_STATUS_PREFIX}done\n${ASYNC_RC_PREFIX}0\n${ASYNC_OUT_PREFIX}\n${ASYNC_ERR_PREFIX}`;
    const result = parseAsyncOutput(raw);
    assert.deepEqual(result, { status: "done", exitCode: 0, stdout: "", stderr: "" });
  });

  it("reports a still-running handle", () => {
    assert.deepEqual(parseAsyncOutput(`\n${ASYNC_STATUS_PREFIX}running\n`), { status: "running" });
  });

  it("reports a missing run", () => {
    assert.deepEqual(parseAsyncOutput(`\n${ASYNC_STATUS_PREFIX}missing\n`), { status: "missing" });
  });

  it("treats output with no status marker as unknown", () => {
    assert.equal(parseAsyncOutput("ssh: connect failed").status, "unknown");
  });

  it("treats a done marker with no exit code as unknown", () => {
    assert.equal(parseAsyncOutput(`${ASYNC_STATUS_PREFIX}done\n${ASYNC_OUT_PREFIX}`).status, "unknown");
  });

  it("decodes a ready snapshot while the run keeps going", () => {
    const out = Buffer.from("Waiting for changes\n", "utf8").toString("base64");
    const raw = `\n${ASYNC_STATUS_PREFIX}ready\n${ASYNC_OUT_PREFIX}${out}`;
    assert.deepEqual(parseAsyncOutput(raw), { status: "ready", stdout: "Waiting for changes\n" });
  });
});

describe("liveness", () => {
  it("parseAsyncOutput reports a dead run when the process vanished without an rc", () => {
    assert.deepEqual(parseAsyncOutput(`\n${ASYNC_STATUS_PREFIX}dead\n`), { status: "dead" });
  });

  it("buildAsyncWait probes pid liveness and emits dead when the process is gone", () => {
    const script = buildAsyncWait(RUN_ID, 5);
    assert.ok(script.includes('kill -0'), "wait must probe the pid with kill -0");
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}dead`), "wait must be able to report dead");
  });

  it("buildAsyncReadyWait emits dead when the process dies before readiness", () => {
    const script = buildAsyncReadyWait(RUN_ID, 5, { kind: "tcp", port: 35565 });
    assert.ok(script.includes('kill -0'), "ready-wait must probe the pid with kill -0");
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}dead`), "ready-wait must be able to report dead");
  });

  it("buildLogsCommand emits dead when the process is gone without an rc", () => {
    const script = buildLogsCommand(RUN_ID);
    assert.ok(script.includes('kill -0'), "logs must probe the pid with kill -0");
    assert.ok(script.includes(`${LOGS_STATUS_PREFIX}dead`), "logs must be able to report dead");
  });

  it("parseLogsOutput reports a dead run with its captured tail", () => {
    const out = Buffer.from("boom\n", "utf8").toString("base64");
    const raw = `\n${LOGS_STATUS_PREFIX}dead\n${ASYNC_OUT_PREFIX}${out}\n${ASYNC_ERR_PREFIX}`;
    assert.deepEqual(parseLogsOutput(raw), { status: "dead", stdout: "boom\n", stderr: "", exitCode: undefined });
  });
});

describe("parseReadySpec", () => {
  it("parses a tcp or port spec into a numeric port", () => {
    assert.deepEqual(parseReadySpec("tcp:35565"), { kind: "tcp", port: 35565 });
    assert.deepEqual(parseReadySpec("port:443"), { kind: "tcp", port: 443 });
  });

  it("parses a log spec, keeping the regex verbatim", () => {
    assert.deepEqual(parseReadySpec("log:Waiting for changes"), { kind: "log", pattern: "Waiting for changes" });
  });

  it("rejects a malformed, out-of-range, or unknown spec", () => {
    assert.throws(() => parseReadySpec("35565"), /invalid --ready-when/);
    assert.throws(() => parseReadySpec("tcp:0"), /port/);
    assert.throws(() => parseReadySpec("tcp:70000"), /port/);
    assert.throws(() => parseReadySpec("log:"), /empty/);
    assert.throws(() => parseReadySpec("http:80"), /unknown --ready-when kind/);
  });
});

describe("buildAsyncReadyWait", () => {
  it("breaks on completion or readiness and emits a ready snapshot for a tcp gate", () => {
    const script = buildAsyncReadyWait(RUN_ID, 30, { kind: "tcp", port: 35565 });
    assert.ok(script.includes("ss -ltn"));
    assert.ok(script.includes(":35565$"));
    assert.ok(script.includes('[ -f "$RUN_DIR/rc" ] && break'));
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}ready`));
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}done`));
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}running`));
  });

  it("greps the run's stdout for a log gate using a base64-encoded pattern", () => {
    const script = buildAsyncReadyWait(RUN_ID, 30, { kind: "log", pattern: "Waiting for changes" });
    const patternB64 = Buffer.from("Waiting for changes", "utf8").toString("base64");
    assert.ok(script.includes(patternB64));
    assert.ok(script.includes('grep -qE -- "$__pat" "$RUN_DIR/out"'));
    // The raw pattern must not leak into the launcher shell as syntax.
    assert.ok(!script.includes("Waiting for changes"));
  });

  it("gates the ready branch on a live pid so a dead run with a stale marker is not read as ready", () => {
    const script = buildAsyncReadyWait(RUN_ID, 30, { kind: "log", pattern: "Waiting for changes" });
    // A log gate matches the accumulated stdout file, which survives the process.
    // After a suspend or crash that file still holds the marker, so the ready
    // branch must require a live pid or a dead watch reports ready forever.
    assert.ok(
      script.includes('elif [ "$__ready" = 1 ] && [ -f "$RUN_DIR/pid" ] && kill -0 "$(cat "$RUN_DIR/pid")" 2>/dev/null; then'),
      "the ready branch must require a live pid",
    );
  });
});

describe("buildAsyncExecReady", () => {
  it("launches detached and then waits on the readiness gate", () => {
    const script = buildAsyncExecReady(RUN_ID, "rush start", { cwd: "/workspaces/app", budgetSeconds: 40, ready: { kind: "tcp", port: 35565 } });
    assert.ok(script.includes('nohup bash -l "$RUN_DIR/run.sh"'));
    assert.ok(script.includes(":35565$"));
    assert.ok(script.includes(`${ASYNC_STATUS_PREFIX}ready`));
  });
});

describe("buildLogsCommand", () => {
  it("tails the run output without removing the run directory", () => {
    const script = buildLogsCommand(RUN_ID, { lines: 50 });
    assert.ok(script.includes(`RUN_DIR="$HOME/.plothole/runs/${RUN_ID}"`));
    assert.ok(script.includes("tail -n 50"));
    assert.ok(script.includes(`${LOGS_STATUS_PREFIX}running`));
    assert.ok(script.includes(`${LOGS_STATUS_PREFIX}done`));
    assert.ok(!script.includes("rm -rf"), "logs must never delete the run");
    assert.ok(!script.includes("nohup"), "logs must never launch anything");
  });

  it("defaults to 200 trailing lines and rejects an unsafe run id", () => {
    assert.ok(buildLogsCommand(RUN_ID).includes("tail -n 200"));
    assert.throws(() => buildLogsCommand("../etc"), /unsafe run id/);
  });
});

describe("parseLogsOutput", () => {
  it("decodes a running tail with no exit code", () => {
    const out = Buffer.from("compiling...\n", "utf8").toString("base64");
    const err = Buffer.from("", "utf8").toString("base64");
    const raw = `\n${LOGS_STATUS_PREFIX}running\n${ASYNC_OUT_PREFIX}${out}\n${ASYNC_ERR_PREFIX}${err}`;
    assert.deepEqual(parseLogsOutput(raw), { status: "running", stdout: "compiling...\n", stderr: "", exitCode: undefined });
  });

  it("decodes a finished tail with its exit code", () => {
    const out = Buffer.from("done\n", "utf8").toString("base64");
    const err = Buffer.from("warn\n", "utf8").toString("base64");
    const raw = `\n${LOGS_STATUS_PREFIX}done\n${ASYNC_RC_PREFIX}0\n${ASYNC_OUT_PREFIX}${out}\n${ASYNC_ERR_PREFIX}${err}`;
    assert.deepEqual(parseLogsOutput(raw), { status: "done", stdout: "done\n", stderr: "warn\n", exitCode: 0 });
  });

  it("reports a missing run and treats no marker as unknown", () => {
    assert.deepEqual(parseLogsOutput(`\n${LOGS_STATUS_PREFIX}missing\n`), { status: "missing" });
    assert.equal(parseLogsOutput("ssh: connect failed").status, "unknown");
  });
});
