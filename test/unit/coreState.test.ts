import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import {
  getActiveCodespace,
  getRoot,
  setRoot,
  clearRoot,
  readState,
  recordRun,
  getRun,
  setRunRush,
  setActiveCodespace,
  writeState,
  type RunRecord,
} from "../../src/core/state.js";
import { INLINE_LIMIT, backIfLarge } from "../../src/core/output.js";
import { resolveCodespace, resolveCwd } from "../../src/core/verbs.js";
import { PlotholeError } from "../../src/core/errors.js";

describe("state", () => {
  beforeEach(() => {
    // The test runner shares one sandbox HOME across files, so start from a
    // clean state file rather than inheriting runs a prior file recorded.
    writeState({});
  });

  it("round-trips the active codespace through the state file", () => {
    setActiveCodespace("sample-codespace");
    assert.equal(getActiveCodespace(), "sample-codespace");
    assert.deepEqual(readState(), { activeCodespace: "sample-codespace" });
  });

  it("returns undefined when no codespace is set", () => {
    writeState({});
    assert.equal(getActiveCodespace(), undefined);
  });
});

describe("per-codespace root", () => {
  beforeEach(() => {
    writeState({});
  });

  it("round-trips a root scoped to one codespace", () => {
    setRoot("cs-a", "/workspaces/app");
    assert.equal(getRoot("cs-a"), "/workspaces/app");
    assert.equal(getRoot("cs-b"), undefined);
  });

  it("clears only the named codespace's root", () => {
    setRoot("cs-a", "/workspaces/app");
    setRoot("cs-b", "/workspaces/other");
    clearRoot("cs-a");
    assert.equal(getRoot("cs-a"), undefined);
    assert.equal(getRoot("cs-b"), "/workspaces/other");
  });
});

describe("resolveCwd", () => {
  beforeEach(() => {
    writeState({});
  });

  it("returns the configured root when no explicit cwd is given", () => {
    setRoot("cs-a", "/workspaces/app");
    assert.equal(resolveCwd("cs-a"), "/workspaces/app");
  });

  it("returns undefined with neither a root nor an explicit cwd", () => {
    assert.equal(resolveCwd("cs-a"), undefined);
  });

  it("lets an absolute cwd win over the root", () => {
    setRoot("cs-a", "/workspaces/app");
    assert.equal(resolveCwd("cs-a", "/tmp/elsewhere"), "/tmp/elsewhere");
  });

  it("resolves a relative cwd under the root", () => {
    setRoot("cs-a", "/workspaces/app/");
    assert.equal(resolveCwd("cs-a", "packages/app"), "/workspaces/app/packages/app");
  });

  it("passes a relative cwd through unchanged when no root is set", () => {
    assert.equal(resolveCwd("cs-a", "packages/app"), "packages/app");
  });
});

describe("output file-backing", () => {
  it("keeps small output inline", () => {
    const result = backIfLarge("hello", "test");
    assert.equal(result.inline, "hello");
    assert.equal(result.fileBacked, undefined);
    assert.equal(result.bytes, 5);
  });

  it("writes large output to a file and returns the path", () => {
    const big = "x".repeat(INLINE_LIMIT + 1);
    const result = backIfLarge(big, "build");
    assert.equal(result.inline, undefined);
    assert.equal(result.fileBacked, true);
    assert.ok(result.file !== undefined && existsSync(result.file));
    assert.equal(readFileSync(result.file as string, "utf8"), big);
  });
});

describe("resolveCodespace", () => {
  it("prefers an explicit host", () => {
    assert.equal(resolveCodespace("explicit-cs"), "explicit-cs");
  });

  it("throws an actionable error when nothing is selected", () => {
    writeState({});
    assert.throws(() => resolveCodespace(), (err: unknown) => {
      assert.ok(err instanceof PlotholeError);
      assert.match(err.hint ?? "", /session --ensure|--host/);
      return true;
    });
  });
});

describe("setRunRush", () => {
  const RUN: RunRecord = {
    runId: "rush-run-1",
    codespace: "sample-codespace",
    command: "rush start",
    cwd: "/workspaces/app",
    startedAt: "2026-06-14T00:00:00.000Z",
  };

  beforeEach(() => writeState({}));

  it("attaches rush provenance to a tracked run so a later wait can keep its forward hint", () => {
    recordRun(RUN);
    setRunRush(RUN.runId, { subcommand: "start", mode: "watch", port: 46435 });
    assert.deepEqual(getRun(RUN.runId)?.rush, { subcommand: "start", mode: "watch", port: 46435 });
  });

  it("is a no-op for an unknown run", () => {
    setRunRush("missing", { subcommand: "start", mode: "watch", port: 46435 });
    assert.equal(getRun("missing"), undefined);
  });
});
