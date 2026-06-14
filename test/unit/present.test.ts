import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { presentExec, presentLogs, presentRush } from "../../src/present.js";

const FAILURES = { operations: 2, failed: ["@scope/a (_phase_build)", "@scope/b (_phase_test)"] };

describe("presentExec failure surfacing", () => {
  it("includes failures on a completed result that had build failures", () => {
    const payload = presentExec({
      status: "completed",
      codespace: "cs",
      runId: "r",
      exitCode: 0,
      stdout: "x",
      stderr: "",
      failures: FAILURES,
    });
    assert.deepEqual(payload.failures, FAILURES);
  });

  it("omits the failures key entirely when a completed result had none", () => {
    const payload = presentExec({
      status: "completed",
      codespace: "cs",
      runId: "r",
      exitCode: 0,
      stdout: "x",
      stderr: "",
    });
    assert.ok(!("failures" in payload), "a clean result must not carry an empty failures key");
  });

  it("surfaces the subcommand and mode when a resumed completed result carries rush provenance", () => {
    const payload = presentExec({
      status: "completed",
      codespace: "cs",
      runId: "r",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      rush: { subcommand: "build", mode: "once" },
    });
    assert.equal(payload.subcommand, "build");
    assert.equal(payload.mode, "once");
  });

  it("includes failures on a ready watch build", () => {
    const payload = presentExec({
      status: "ready",
      codespace: "cs",
      runId: "r",
      runDir: "~/.plothole/runs/r",
      stdout: "x",
      failures: FAILURES,
    });
    assert.deepEqual(payload.failures, FAILURES);
  });

  it("surfaces a port and forward hint when a resumed ready result carries rush provenance", () => {
    const payload = presentExec({
      status: "ready",
      codespace: "cs",
      runId: "r",
      runDir: "~/.plothole/runs/r",
      stdout: "Waiting for changes\n",
      rush: { subcommand: "start", mode: "watch", port: 46435 },
    });
    assert.equal(payload.port, 46435);
    assert.equal(payload.subcommand, "start");
    assert.match(String(payload.hint), /forward 46435/);
    assert.doesNotMatch(String(payload.hint), /https?:\/\//);
  });
});

describe("presentLogs failure surfacing", () => {
  it("includes failures found in the captured tail", () => {
    const payload = presentLogs({
      codespace: "cs",
      runId: "r",
      status: "running",
      stdout: "x",
      stderr: "",
      failures: FAILURES,
    });
    assert.deepEqual(payload.failures, FAILURES);
  });

  it("omits the failures key when the tail was clean", () => {
    const payload = presentLogs({ codespace: "cs", runId: "r", status: "running", stdout: "x", stderr: "" });
    assert.ok(!("failures" in payload));
  });

  it("passes a dead status through honestly", () => {
    const payload = presentLogs({ codespace: "cs", runId: "r", status: "dead", stdout: "boom", stderr: "" });
    assert.equal(payload.status, "dead");
  });

  it("surfaces the port and subcommand when the tailed run carries rush provenance", () => {
    const payload = presentLogs({
      codespace: "cs",
      runId: "r",
      status: "running",
      stdout: "Waiting for changes\n",
      stderr: "",
      rush: { subcommand: "start", mode: "watch", port: 46435 },
    });
    assert.equal(payload.port, 46435);
    assert.equal(payload.subcommand, "start");
  });
});

describe("presentRush", () => {
  it("surfaces a ready watch with its port and a forward hint", () => {
    const payload = presentRush({
      status: "ready",
      codespace: "cs",
      runId: "r",
      subcommand: "start",
      mode: "watch",
      port: 46435,
      runDir: "~/.plothole/runs/r",
      stdout: "Waiting for changes\n",
      failures: FAILURES,
    });
    assert.equal(payload.status, "ready");
    assert.equal(payload.subcommand, "start");
    assert.equal(payload.mode, "watch");
    assert.equal(payload.port, 46435);
    assert.deepEqual(payload.failures, FAILURES);
    assert.match(String(payload.hint), /forward 46435/);
    assert.doesNotMatch(String(payload.hint), /https?:\/\//);
  });

  it("surfaces a completed build with its exit code and omits failures when clean", () => {
    const payload = presentRush({
      status: "completed",
      codespace: "cs",
      runId: "r",
      subcommand: "build",
      mode: "once",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    assert.equal(payload.status, "completed");
    assert.equal(payload.mode, "once");
    assert.equal(payload.exitCode, 0);
    assert.ok(!("failures" in payload), "a clean build must not carry an empty failures key");
  });

  it("does not claim a dev server is serving for a port-less watch such as build-watch", () => {
    const payload = presentRush({
      status: "ready",
      codespace: "cs",
      runId: "r",
      subcommand: "build-watch",
      mode: "watch",
      runDir: "~/.plothole/runs/r",
      stdout: "Waiting for changes\n",
    });
    assert.equal(payload.status, "ready");
    assert.doesNotMatch(String(payload.hint), /dev server is serving/);
  });
});
