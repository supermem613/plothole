import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildKillCommand } from "../../src/core/remote.js";
import { KILL_STATUS_PREFIX, parseKillOutput } from "../../src/core/asyncRun.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";

describe("buildKillCommand", () => {
  it("targets the run directory and signals the whole subprocess tree", () => {
    const script = buildKillCommand(RUN_ID);
    assert.ok(script.includes(`RUN_DIR="$HOME/.plothole/runs/${RUN_ID}"`));
    assert.ok(script.includes('__root=$(cat "$RUN_DIR/pid")'));
    assert.ok(script.includes("pgrep -P"));
    assert.ok(script.includes("kill -TERM $__pids"));
    assert.ok(script.includes("kill -KILL $__pids"));
    assert.ok(script.includes('rm -rf "$RUN_DIR"'));
  });

  it("emits a status marker for every branch", () => {
    const script = buildKillCommand(RUN_ID);
    assert.ok(script.includes(`${KILL_STATUS_PREFIX}missing`));
    assert.ok(script.includes(`${KILL_STATUS_PREFIX}not-running`));
    assert.ok(script.includes(`${KILL_STATUS_PREFIX}killed`));
  });

  it("rejects an unsafe run id", () => {
    assert.throws(() => buildKillCommand("../etc"), /unsafe run id/);
  });
});

describe("parseKillOutput", () => {
  it("reads each known status", () => {
    assert.equal(parseKillOutput(`\n${KILL_STATUS_PREFIX}killed\n`), "killed");
    assert.equal(parseKillOutput(`\n${KILL_STATUS_PREFIX}not-running\n`), "not-running");
    assert.equal(parseKillOutput(`\n${KILL_STATUS_PREFIX}missing\n`), "missing");
  });

  it("treats output with no marker as unknown", () => {
    assert.equal(parseKillOutput("ssh: connect failed"), "unknown");
  });
});
