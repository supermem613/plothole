import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { scanFailures } from "../../src/core/failures.js";

// A realistic rushstack failure summary, padded banners and per-op detail
// headers as OperationResultSummarizerPlugin emits them.
const FAILED_RUN = [
  "These operations completed successfully:",
  "  @scope/app-cores",
  "",
  "==[ FAILURE: 2 operations ]====================================================",
  "",
  "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
  "  [build] src/Foo.ts:3:1 - error TS1005",
  "--[ FAILURE: @scope/media (_phase_test) ]------[ 0.50 seconds ]--",
  "  Uploading 14 files...",
  "  AuthorizationPermissionMismatch",
  "",
  "Operations failed.",
].join("\n");

describe("scanFailures", () => {
  it("reads the failure count from the summary banner and the failed operation names", () => {
    const scan = scanFailures(FAILED_RUN);
    assert.ok(scan, "a failed run must produce a scan");
    assert.equal(scan.operations, 2);
    assert.deepEqual(scan.failed, [
      "@scope/pages (_phase_build)",
      "@scope/media (_phase_test)",
    ]);
  });

  it("returns undefined for an all-success run", () => {
    const ok = [
      "These operations completed successfully:",
      "  @scope/pages",
      "",
      "==[ SUCCESS: 37 operations ]===================================================",
    ].join("\n");
    assert.equal(scanFailures(ok), undefined);
  });

  it("returns undefined for output with no operation banners at all", () => {
    assert.equal(scanFailures("Waiting for changes...\n"), undefined);
    assert.equal(scanFailures(""), undefined);
  });

  it("detects a single failure with the singular 'operation' wording", () => {
    const one = [
      "==[ FAILURE: 1 operation ]=====================================================",
      "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
    ].join("\n");
    const scan = scanFailures(one);
    assert.ok(scan);
    assert.equal(scan.operations, 1);
    assert.deepEqual(scan.failed, ["@scope/pages (_phase_build)"]);
  });

  it("sees through ANSI color codes rush emits to a color-capable terminal", () => {
    const colored =
      "\u001b[90m==[\u001b[39m \u001b[31mFAILURE: 1 operation\u001b[39m \u001b[90m]===\u001b[39m\n" +
      "\u001b[90m--[\u001b[39m \u001b[31mFAILURE: @scope/pages (_phase_build)\u001b[39m \u001b[90m]---[\u001b[39m 1.2s \u001b[90m]--\u001b[39m";
    const scan = scanFailures(colored);
    assert.ok(scan);
    assert.equal(scan.operations, 1);
    assert.deepEqual(scan.failed, ["@scope/pages (_phase_build)"]);
  });

  it("falls back to the detail-header count when only the per-op headers survive a tail", () => {
    const tail = [
      "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
      "  some error",
    ].join("\n");
    const scan = scanFailures(tail);
    assert.ok(scan);
    assert.equal(scan.operations, 1);
    assert.deepEqual(scan.failed, ["@scope/pages (_phase_build)"]);
  });

  it("scans only the latest build epoch so a clean rebuild after a failed one is green", () => {
    const watchLog = [
      "==[ FAILURE: 1 operation ]=====================================================",
      "--[ FAILURE: @scope/pages (_phase_build) ]-------------------[ 1.23 seconds ]--",
      "  error TS1005",
      "[WATCHING] Watch Status: Waiting for changes...",
      "==[ SUCCESS: 12 operations ]===================================================",
      "--[ SUCCESS: @scope/pages (_phase_build) ]------------------[ 2.00 seconds ]--",
      "[WATCHING] Watch Status: Waiting for changes...",
    ].join("\n");
    assert.equal(
      scanFailures(watchLog),
      undefined,
      "a watch whose most recent build succeeded must not stay red from an earlier failure",
    );
  });

  it("still reports failures when the most recent build epoch is the failed one", () => {
    const watchLog = [
      "==[ SUCCESS: 12 operations ]===================================================",
      "[WATCHING] Watch Status: Waiting for changes...",
      "==[ FAILURE: 1 operation ]=====================================================",
      "--[ FAILURE: @scope/foo (_phase_build) ]-----------------------[ 1.20 seconds ]--",
      "  error TS2304",
      "[WATCHING] Watch Status: Waiting for changes...",
    ].join("\n");
    const scan = scanFailures(watchLog);
    assert.ok(scan, "a watch whose latest build failed must surface the failure");
    assert.equal(scan.operations, 1);
    assert.deepEqual(scan.failed, ["@scope/foo (_phase_build)"]);
  });
});
