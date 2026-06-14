import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { listRuns, recordRun, writeState, type RunRecord } from "../../src/core/state.js";
import { cleanVerb } from "../../src/core/verbs.js";
import type { AsyncRunOutcome } from "../../src/core/asyncRun.js";

function run(runId: string, codespace = "sample-codespace"): RunRecord {
  return { runId, codespace, command: "rush build", startedAt: "2026-06-13T00:00:00.000Z" };
}

describe("cleanVerb", () => {
  beforeEach(() => {
    writeState({});
  });

  it("removes done and missing runs but keeps a still-running one", async () => {
    recordRun(run("done-1"));
    recordRun(run("missing-1"));
    recordRun(run("running-1"));
    const outcomes: Record<string, AsyncRunOutcome> = {
      "done-1": { status: "done", exitCode: 0, stdout: "", stderr: "" },
      "missing-1": { status: "missing" },
      "running-1": { status: "running" },
    };
    const result = await cleanVerb((_codespace, runId) => Promise.resolve(outcomes[runId]));
    const byId = Object.fromEntries(result.cleaned.map((entry) => [entry.runId, entry.disposition]));
    assert.equal(byId["done-1"], "removed");
    assert.equal(byId["missing-1"], "removed");
    assert.equal(byId["running-1"], "running");
    assert.deepEqual(listRuns().map((entry) => entry.runId), ["running-1"]);
  });

  it("keeps a run whose codespace poll throws and reports the error", async () => {
    recordRun(run("err-1"));
    const result = await cleanVerb(() => Promise.reject(new Error("ssh: connect failed")));
    assert.equal(result.cleaned[0].disposition, "error");
    assert.match(result.cleaned[0].reason ?? "", /connect failed/);
    assert.deepEqual(listRuns().map((entry) => entry.runId), ["err-1"]);
  });

  it("returns an empty list when nothing is tracked", async () => {
    const result = await cleanVerb(() => Promise.resolve({ status: "missing" }));
    assert.deepEqual(result.cleaned, []);
  });
});
