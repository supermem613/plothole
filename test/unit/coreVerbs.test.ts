import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { writeState, recordRun, getRun, type RunRecord } from "../../src/core/state.js";
import { waitVerb, logsVerb, cleanVerb, execVerb, execToCompletionVerb, rushVerb, rushToCompletionVerb, rushExitCode, execExitCode, checkSpfxDeploy } from "../../src/core/verbs.js";
import type { AsyncRunOutcome, LogsOutcome } from "../../src/core/asyncRun.js";
import type { RemoteResult } from "../../src/core/transport.js";

const RUN: RunRecord = {
  runId: "dead-run-1",
  codespace: "sample-codespace",
  command: "rush start",
  cwd: "/workspaces/app",
  startedAt: "2026-06-12T00:00:00.000Z",
};

// A rush start landing page that served the scenario carries a real
// spfxDebugQueryString slot. Healthy pages ALSO show a demo-apps "(Not Deployed)"
// card, so the fixture includes it to prove the classifier scopes to the slot and
// is not fooled by a stray "(Not Deployed)" elsewhere on a healthy page.
const HEALTHY_PAGE =
  '<section id="sp-client"><code id="spfxDebugQueryString">?debug=true&loader=https://localhost:46435/hashed/sp-loader-assembly.js</code></section>' +
  '<section id="demo-apps"><code>(Not Deployed)</code></section>';
const NOT_DEPLOYED_PAGE = '<code id="spfxDebugQueryString">(Not Deployed)</code>';
const served = (stdout: string): RemoteResult => ({ exitCode: 0, stdout, stderr: "", sentinelFound: true });
const healthyRun = async (): Promise<RemoteResult> => served(HEALTHY_PAGE);
const notDeployedRun = async (): Promise<RemoteResult> => served(NOT_DEPLOYED_PAGE);

describe("waitVerb liveness", () => {
  beforeEach(() => writeState({}));

  it("throws an honest error when the run is dead and keeps the record for inspection", async () => {
    recordRun(RUN);
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "dead" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "dead" }),
    };
    await assert.rejects(() => waitVerb({ runId: RUN.runId }, deps), /no longer alive/);
    assert.ok(getRun(RUN.runId), "a dead run stays tracked so logs and kill can still reach it");
  });

  it("collects a completed run and drops its record", async () => {
    recordRun(RUN);
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const result = await waitVerb({ runId: RUN.runId }, deps);
    assert.equal(result.status, "completed");
    assert.equal(getRun(RUN.runId), undefined);
  });

  it("rehydrates rush provenance onto a resumed completed result so the contract stays uniform", async () => {
    recordRun({ ...RUN, rush: { subcommand: "build", mode: "once" } });
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const result = await waitVerb({ runId: RUN.runId }, deps);
    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.status === "completed" ? result.rush : undefined,
      { subcommand: "build", mode: "once" },
    );
  });
});

describe("cleanVerb liveness", () => {
  beforeEach(() => writeState({}));

  it("reaps a dead run's host record instead of trusting a stale running marker", async () => {
    recordRun(RUN);
    const result = await cleanVerb(async (): Promise<AsyncRunOutcome> => ({ status: "dead" }));
    assert.equal(result.cleaned[0].disposition, "removed");
    assert.equal(result.cleaned[0].reason, "dead");
    assert.equal(getRun(RUN.runId), undefined);
  });

  it("leaves a genuinely running run tracked", async () => {
    recordRun(RUN);
    const result = await cleanVerb(async (): Promise<AsyncRunOutcome> => ({ status: "running" }));
    assert.equal(result.cleaned[0].disposition, "running");
    assert.ok(getRun(RUN.runId));
  });
});

describe("waitVerb readiness re-evaluation", () => {
  beforeEach(() => writeState({}));

  it("re-evaluates a persisted ready-when and returns ready when it now holds", async () => {
    recordRun({ ...RUN, readyWhen: "tcp:46435" });
    let usedReady = false;
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (): Promise<AsyncRunOutcome> => {
        usedReady = true;
        return { status: "ready", stdout: "Waiting for changes\n" };
      },
    };
    const result = await waitVerb({ runId: RUN.runId }, deps);
    assert.ok(usedReady, "wait must re-check readiness for a ready-gated run, not just poll for completion");
    assert.equal(result.status, "ready");
    assert.ok(getRun(RUN.runId), "a still-ready run stays tracked so a later wait can collect its final result");
  });

  it("rehydrates rush provenance onto a resumed ready result so the forward hint survives", async () => {
    recordRun({ ...RUN, readyWhen: "tcp:46435", rush: { subcommand: "start", mode: "watch", port: 46435 } });
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await waitVerb({ runId: RUN.runId }, deps, healthyRun);
    assert.equal(result.status, "ready");
    assert.deepEqual(
      result.status === "ready" ? result.rush : undefined,
      { subcommand: "start", mode: "watch", port: 46435 },
    );
    assert.equal(result.status === "ready" ? result.deploy?.deployed : undefined, true);
  });

  it("asserts deploy state on a resumed ready rush watch and exits nonzero when it did not deploy", async () => {
    recordRun({ ...RUN, readyWhen: "tcp:46435", rush: { subcommand: "start", mode: "watch", port: 46435 } });
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await waitVerb({ runId: RUN.runId }, deps, notDeployedRun);
    assert.equal(result.status, "ready");
    assert.equal(result.status === "ready" ? result.deploy?.deployed : undefined, false);
    assert.equal(execExitCode(result), 1, "a resumed watch that served (Not Deployed) must fail a shell gate");
  });

  it("reserves the deploy probe's budget from the readiness poll on a resumed deploy-asserting watch", async () => {
    recordRun({ ...RUN, readyWhen: "tcp:46435", rush: { subcommand: "start", mode: "watch", port: 46435 } });
    let readyBudget = 0;
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (_cs: string, _id: string, budgetSeconds: number): Promise<AsyncRunOutcome> => {
        readyBudget = budgetSeconds;
        return { status: "ready", stdout: "Waiting for changes\n" };
      },
    };
    await waitVerb({ runId: RUN.runId }, deps, healthyRun);
    assert.ok(readyBudget > 0 && readyBudget < 45, "a resumed deploy-asserting watch reserves part of the budget for the probe");
  });

  it("polls plainly for a run with no persisted ready-when", async () => {
    recordRun(RUN);
    let usedReady = false;
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (): Promise<AsyncRunOutcome> => {
        usedReady = true;
        return { status: "running" };
      },
    };
    const result = await waitVerb({ runId: RUN.runId }, deps);
    assert.ok(!usedReady, "a run with no ready-when must use the plain wait");
    assert.equal(result.status, "running");
  });

  it("collects the final result when a ready-gated run has since finished", async () => {
    recordRun({ ...RUN, readyWhen: "tcp:46435" });
    const deps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const result = await waitVerb({ runId: RUN.runId }, deps);
    assert.equal(result.status, "completed");
    assert.equal(getRun(RUN.runId), undefined);
  });
});

describe("execVerb readiness persistence", () => {
  beforeEach(() => writeState({}));

  it("persists the ready-when on a backgrounded ready-gated run so a later wait can re-check it", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await execVerb({ codespace: "cs1", command: "rush start", readyWhen: "tcp:46435" }, deps);
    assert.equal(result.status, "ready");
    assert.equal(getRun(result.runId)?.readyWhen, "tcp:46435");
  });

  it("records no ready-when for a plain backgrounded run", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "" }),
    };
    const result = await execVerb({ codespace: "cs1", command: "sleep 999" }, deps);
    assert.equal(result.status, "running");
    assert.equal(getRun(result.runId)?.readyWhen, undefined);
  });
});

describe("execToCompletionVerb", () => {
  beforeEach(() => writeState({}));

  it("blocks a backgrounded exec to its completed result instead of handing back a running handle", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
    };
    const waitDeps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 3, stdout: "out", stderr: "err" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 3, stdout: "out", stderr: "err" }),
    };
    const result = await execToCompletionVerb({ codespace: "cs1", command: "rush build" }, deps, waitDeps);
    assert.equal(result.status, "completed");
    assert.equal(result.status === "completed" ? result.exitCode : undefined, 3, "the real exit code survives the block");
    assert.equal(getRun(result.runId), undefined, "a collected run is no longer tracked");
  });

  it("returns an inline-completed exec without polling wait", async () => {
    let waited = false;
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const waitDeps = {
      wait: async (): Promise<AsyncRunOutcome> => {
        waited = true;
        return { status: "running" };
      },
      readyWait: async (): Promise<AsyncRunOutcome> => {
        waited = true;
        return { status: "running" };
      },
    };
    const result = await execToCompletionVerb({ codespace: "cs1", command: "echo hi" }, deps, waitDeps);
    assert.equal(result.status, "completed");
    assert.equal(waited, false, "a command that finished in the first call must not poll wait");
  });

  it("treats a ready dev server as terminal so a watch returns once up instead of blocking on a process that never exits", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
    };
    const waitDeps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await execToCompletionVerb({ codespace: "cs1", command: "rush start", readyWhen: "tcp:46435" }, deps, waitDeps);
    assert.equal(result.status, "ready", "a ready watch is terminal for the blocking path");
  });
});

describe("rushToCompletionVerb", () => {
  beforeEach(() => writeState({}));

  const FAILED_BUILD = [
    "==[ FAILURE: 1 operation ]=====================================================",
    "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
    "  error TS1005",
  ].join("\n");

  it("blocks a backgrounded build to its completed result and keeps the rush framing and failures", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
    };
    const waitDeps = {
      wait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 1, stdout: FAILED_BUILD, stderr: "" }),
      readyWait: async (): Promise<AsyncRunOutcome> => ({ status: "done", exitCode: 1, stdout: FAILED_BUILD, stderr: "" }),
    };
    const result = await rushToCompletionVerb({ codespace: "cs1", subcommand: "build", to: ["@scope/app"] }, deps, waitDeps);
    assert.equal(result.status, "completed");
    assert.equal(result.subcommand, "build");
    assert.equal(result.mode, "once");
    assert.equal(result.exitCode, 1);
    assert.ok(result.failures, "a failed sub-build must still surface after the block");
    assert.equal(rushExitCode(result), 1);
  });

  it("returns an inline-ready watch unchanged without polling wait", async () => {
    let waited = false;
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const waitDeps = {
      wait: async (): Promise<AsyncRunOutcome> => {
        waited = true;
        return { status: "running" };
      },
      readyWait: async (): Promise<AsyncRunOutcome> => {
        waited = true;
        return { status: "running" };
      },
    };
    const result = await rushToCompletionVerb({ codespace: "cs1", subcommand: "start", to: ["@scope/app"] }, deps, waitDeps);
    assert.equal(result.status, "ready");
    assert.equal(waited, false, "a watch that reached ready in the first call must not poll wait");
  });
});

describe("failure surfacing", () => {
  beforeEach(() => writeState({}));

  const FAILED_TAIL = [
    "==[ FAILURE: 1 operation ]=====================================================",
    "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
    "  error TS1005",
  ].join("\n");

  it("logsVerb surfaces build failures found in the captured tail", async () => {
    recordRun(RUN);
    const deps = {
      logs: async (): Promise<Exclude<LogsOutcome, { status: "unknown" }>> => ({
        status: "running",
        stdout: FAILED_TAIL,
        stderr: "",
        exitCode: undefined,
      }),
    };
    const result = await logsVerb({ runId: RUN.runId }, deps);
    assert.ok(result.failures, "a tail with FAILURE banners must surface failures");
    assert.equal(result.failures.operations, 1);
    assert.deepEqual(result.failures.failed, ["@scope/pages (_phase_build)"]);
  });

  it("logsVerb leaves failures undefined for a clean tail", async () => {
    recordRun(RUN);
    const deps = {
      logs: async (): Promise<Exclude<LogsOutcome, { status: "unknown" }>> => ({
        status: "running",
        stdout: "Waiting for changes...\n",
        stderr: "",
        exitCode: undefined,
      }),
    };
    const result = await logsVerb({ runId: RUN.runId }, deps);
    assert.equal(result.failures, undefined);
  });

  it("logsVerb rehydrates rush provenance so a resumed tail keeps the port", async () => {
    recordRun({ ...RUN, rush: { subcommand: "start", mode: "watch", port: 46435 } });
    const deps = {
      logs: async (): Promise<Exclude<LogsOutcome, { status: "unknown" }>> => ({
        status: "running",
        stdout: "Waiting for changes...\n",
        stderr: "",
        exitCode: undefined,
      }),
    };
    const result = await logsVerb({ runId: RUN.runId }, deps);
    assert.deepEqual(result.rush, { subcommand: "start", mode: "watch", port: 46435 });
  });

  it("execVerb surfaces failures when a ready watch build came up with a failed sub-build", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: FAILED_TAIL }),
    };
    const result = await execVerb(
      { codespace: "cs1", command: "rush start", readyWhen: "log:Waiting for changes" },
      deps,
    );
    assert.equal(result.status, "ready");
    assert.ok(result.status === "ready" && result.failures, "a ready build with failures must surface them");
  });
});

describe("logsVerb liveness", () => {
  beforeEach(() => writeState({}));

  it("reports a dead run with its captured tail rather than running", async () => {
    recordRun(RUN);
    const deps = {
      logs: async (): Promise<Exclude<LogsOutcome, { status: "unknown" }>> => ({
        status: "dead",
        stdout: "boom\n",
        stderr: "",
        exitCode: undefined,
      }),
    };
    const result = await logsVerb({ runId: RUN.runId }, deps);
    assert.equal(result.status, "dead");
    assert.equal(result.stdout, "boom\n");
  });
});

describe("rushVerb", () => {
  beforeEach(() => writeState({}));

  const FAILED_BUILD = [
    "==[ FAILURE: 1 operation ]=====================================================",
    "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
    "  error TS1005",
  ].join("\n");

  it("runs a watch start through the ready gate and reports a ready dev server", async () => {
    let execCalled = false;
    let readyCommand = "";
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => {
        execCalled = true;
        return { status: "running" };
      },
      execReady: async (_cs: string, _id: string, command: string): Promise<AsyncRunOutcome> => {
        readyCommand = command;
        return { status: "ready", stdout: "Waiting for changes\n" };
      },
    };
    const result = await rushVerb(
      { codespace: "cs1", subcommand: "start", to: ["tag:web-app", "@scope/app"], port: 46435 },
      deps,
      healthyRun,
    );
    assert.equal(result.status, "ready");
    assert.equal(result.mode, "watch");
    assert.equal(result.port, 46435);
    assert.equal(result.subcommand, "start");
    assert.equal(result.deploy?.deployed, true, "a ready watch must assert its deploy state inline");
    assert.ok(result.runId, "a backgrounded ready watch must carry a runId to tail and collect");
    assert.equal(execCalled, false, "a watch subcommand must go through the ready gate, not a plain exec");
    assert.match(readyCommand, /\brush\b/);
    assert.match(readyCommand, /\bstart\b/);
    assert.match(readyCommand, /web-app/);
  });

  it("runs a build to completion with no ready gate and surfaces build failures", async () => {
    let readyCalled = false;
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({
        status: "done",
        exitCode: 1,
        stdout: FAILED_BUILD,
        stderr: "",
      }),
      execReady: async (): Promise<AsyncRunOutcome> => {
        readyCalled = true;
        return { status: "ready", stdout: "" };
      },
    };
    const result = await rushVerb({ codespace: "cs1", subcommand: "build", to: ["@scope/app"] }, deps);
    assert.equal(result.status, "completed");
    assert.equal(result.mode, "once");
    assert.equal(result.exitCode, 1);
    assert.equal(readyCalled, false, "a run-to-completion subcommand must not use the ready gate");
    assert.ok(result.failures, "a failed build must surface its failures");
    assert.deepEqual(result.failures.failed, ["@scope/pages (_phase_build)"]);
  });

  it("persists rush provenance on a backgrounded ready watch so a later wait keeps the forward hint", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await rushVerb(
      { codespace: "cs1", subcommand: "start", to: ["@scope/app"], port: 46435 },
      deps,
      healthyRun,
    );
    assert.equal(result.status, "ready");
    assert.deepEqual(getRun(result.runId)?.rush, { subcommand: "start", mode: "watch", port: 46435 });
  });

  it("folds the deploy assertion into an inline-ready watch and fails when it served (Not Deployed)", async () => {
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await rushVerb(
      { codespace: "cs1", subcommand: "start", to: ["@scope/app"], port: 46435 },
      deps,
      notDeployedRun,
    );
    assert.equal(result.status, "ready");
    assert.equal(result.deploy?.deployed, false);
    assert.equal(rushExitCode(result), 1, "a ready watch that served (Not Deployed) must fail a shell gate");
  });

  it("skips the deploy assertion for a portless watch so it never fetches a port it has no claim to", async () => {
    let fetched = false;
    const run = async (): Promise<RemoteResult> => {
      fetched = true;
      return served(HEALTHY_PAGE);
    };
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (): Promise<AsyncRunOutcome> => ({ status: "ready", stdout: "Waiting for changes\n" }),
    };
    const result = await rushVerb({ codespace: "cs1", subcommand: "start", to: ["@scope/app"] }, deps, run);
    assert.equal(result.status, "ready");
    assert.equal(result.deploy, undefined);
    assert.equal(fetched, false, "a watch with no port has no dev server to assert");
  });

  it("reserves the deploy probe's budget from the readiness poll so one call fits the async budget", async () => {
    let readyBudget = 0;
    const deps = {
      exec: async (): Promise<AsyncRunOutcome> => ({ status: "running" }),
      execReady: async (_cs: string, _id: string, _command: string, opts: { budgetSeconds: number }): Promise<AsyncRunOutcome> => {
        readyBudget = opts.budgetSeconds;
        return { status: "ready", stdout: "Waiting for changes\n" };
      },
    };
    await rushVerb({ codespace: "cs1", subcommand: "start", to: ["@scope/app"], port: 46435 }, deps, healthyRun);
    assert.ok(readyBudget > 0 && readyBudget < 45, "a deploy-asserting watch reserves part of the budget for the probe");
  });
});

describe("checkSpfxDeploy", () => {
  it("fetches the landing page and reports a deployed dev server", async () => {
    let fetched = "";
    const run = async (_cs: string, command: string): Promise<RemoteResult> => {
      fetched = command;
      return served(HEALTHY_PAGE);
    };
    const status = await checkSpfxDeploy("cs1", 46435, run);
    assert.equal(status.deployed, true);
    assert.ok(status.debugQueryString, "a deployed page must carry the debug query string");
    assert.match(fetched, /curl/);
    assert.match(fetched, /localhost:46435/);
  });

  it("classifies a served-but-not-deployed scenario as a deploy failure, not a transport failure", async () => {
    const status = await checkSpfxDeploy("cs1", 46435, notDeployedRun);
    assert.equal(status.deployed, false);
    assert.match(status.reason, /Not Deployed/);
    assert.notEqual(status.reachable, false, "a fetched page that did not deploy is a closure failure, not unreachable");
  });

  it("reports an unreachable port as a transport failure in a single bounded fetch", async () => {
    let calls = 0;
    const run = async (_cs: string, command: string): Promise<RemoteResult> => {
      calls += 1;
      assert.match(command, /-m 8\b/, "the probe must be bounded so it cannot overrun the reserved budget");
      return { exitCode: 7, stdout: "", stderr: "Connection refused", sentinelFound: true };
    };
    const status = await checkSpfxDeploy("cs1", 46435, run);
    assert.equal(status.deployed, false);
    assert.equal(status.reachable, false, "an unreachable port is a transport failure, not a deploy failure");
    assert.match(status.reason, /did not answer/);
    assert.equal(calls, 1, "the ready marker guarantees the port is up, so the probe must not retry");
  });

  it("surfaces the real error as a transport failure instead of mislabeling a missing curl as not deployed", async () => {
    const run = async (): Promise<RemoteResult> => ({ exitCode: 127, stdout: "", stderr: "bash: curl: command not found", sentinelFound: true });
    const status = await checkSpfxDeploy("cs1", 46435, run);
    assert.equal(status.deployed, false);
    assert.equal(status.reachable, false);
    assert.doesNotMatch(status.reason, /did not answer/);
    assert.match(status.reason, /could not be fetched/);
    assert.match(status.reason, /command not found/);
  });
});

describe("execExitCode", () => {
  it("fails a ready run carrying build failures so a resumed wait is not read as success", () => {
    const code = execExitCode({
      status: "ready",
      codespace: "c",
      runId: "r",
      runDir: "~/.plothole/runs/r",
      stdout: "Waiting for changes\n",
      failures: { operations: 1, failed: ["@scope/pages (_phase_build)"] },
    });
    assert.equal(code, 1);
  });

  it("fails a completed run that exited 0 but had build failures", () => {
    const code = execExitCode({
      status: "completed",
      codespace: "c",
      runId: "r",
      exitCode: 0,
      stdout: "",
      stderr: "",
      failures: { operations: 1, failed: ["@scope/x (_phase_build)"] },
    });
    assert.equal(code, 1);
  });

  it("passes through a real nonzero exit code", () => {
    assert.equal(
      execExitCode({ status: "completed", codespace: "c", runId: "r", exitCode: 2, stdout: "", stderr: "" }),
      2,
    );
  });

  it("is zero for a clean running, ready, or completed run", () => {
    assert.equal(execExitCode({ status: "running", codespace: "c", runId: "r", runDir: "d" }), 0);
    assert.equal(execExitCode({ status: "ready", codespace: "c", runId: "r", runDir: "d", stdout: "" }), 0);
    assert.equal(
      execExitCode({ status: "completed", codespace: "c", runId: "r", exitCode: 0, stdout: "", stderr: "" }),
      0,
    );
  });

  it("fails a ready watch whose deploy assertion came back not deployed", () => {
    const code = execExitCode({
      status: "ready",
      codespace: "c",
      runId: "r",
      runDir: "d",
      stdout: "Waiting for changes\n",
      deploy: { deployed: false, reason: "(Not Deployed)" },
    });
    assert.equal(code, 1);
  });
});

describe("rushExitCode", () => {
  it("fails when a ready watch carries build failures so a clean-looking run is not read as success", () => {
    const code = rushExitCode({
      status: "ready",
      codespace: "c",
      runId: "r",
      subcommand: "start",
      mode: "watch",
      port: 46435,
      failures: { operations: 1, failed: ["@scope/pages (_phase_build)"] },
    });
    assert.equal(code, 1);
  });

  it("fails a completed run that exited 0 but had build failures", () => {
    const code = rushExitCode({
      status: "completed",
      codespace: "c",
      runId: "r",
      subcommand: "build",
      mode: "once",
      exitCode: 0,
      failures: { operations: 1, failed: ["@scope/x (_phase_build)"] },
    });
    assert.equal(code, 1);
  });

  it("passes through a real nonzero exit code", () => {
    const code = rushExitCode({
      status: "completed",
      codespace: "c",
      runId: "r",
      subcommand: "build",
      mode: "once",
      exitCode: 2,
    });
    assert.equal(code, 2);
  });

  it("is zero for a clean ready or completed run", () => {
    assert.equal(
      rushExitCode({ status: "ready", codespace: "c", runId: "r", subcommand: "start", mode: "watch", port: 46435 }),
      0,
    );
    assert.equal(
      rushExitCode({ status: "completed", codespace: "c", runId: "r", subcommand: "build", mode: "once", exitCode: 0 }),
      0,
    );
  });

  it("fails a ready watch whose deploy assertion came back not deployed", () => {
    const code = rushExitCode({
      status: "ready",
      codespace: "c",
      runId: "r",
      subcommand: "start",
      mode: "watch",
      port: 46435,
      deploy: { deployed: false, reason: "(Not Deployed)" },
    });
    assert.equal(code, 1);
  });

  it("is zero for a ready watch that asserted it deployed", () => {
    const code = rushExitCode({
      status: "ready",
      codespace: "c",
      runId: "r",
      subcommand: "start",
      mode: "watch",
      port: 46435,
      deploy: { deployed: true, debugQueryString: "?debug=true", reason: "served" },
    });
    assert.equal(code, 0);
  });
});
