import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  getRun,
  listRuns,
  recordRun,
  removeRun,
  setActiveCodespace,
  writeState,
  type RunRecord,
} from "../../src/core/state.js";

const RUN: RunRecord = {
  runId: "aaaa-1111",
  codespace: "sample-codespace",
  command: "rush build",
  cwd: "/workspaces/app",
  startedAt: "2026-06-12T00:00:00.000Z",
};

describe("run registry", () => {
  beforeEach(() => {
    writeState({});
  });

  it("records and reads back a run", () => {
    recordRun(RUN);
    assert.deepEqual(getRun(RUN.runId), RUN);
    assert.deepEqual(listRuns(), [RUN]);
  });

  it("replaces a run recorded under the same id", () => {
    recordRun(RUN);
    recordRun({ ...RUN, command: "rush rebuild" });
    assert.equal(listRuns().length, 1);
    assert.equal(getRun(RUN.runId)?.command, "rush rebuild");
  });

  it("removes a run and is a no-op for an unknown id", () => {
    recordRun(RUN);
    removeRun("does-not-exist");
    assert.equal(listRuns().length, 1);
    removeRun(RUN.runId);
    assert.equal(getRun(RUN.runId), undefined);
    assert.deepEqual(listRuns(), []);
  });

  it("keeps runs and the active codespace independent in the state file", () => {
    setActiveCodespace("sample-codespace");
    recordRun(RUN);
    assert.equal(getRun(RUN.runId)?.runId, RUN.runId);
    assert.deepEqual(listRuns(), [RUN]);
  });
});
