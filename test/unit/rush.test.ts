import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildRushArgs, rushReadyWhen } from "../../src/core/rush.js";

describe("buildRushArgs", () => {
  it("builds a full rush argv with selectors and port", () => {
    const argv = buildRushArgs({
      subcommand: "start",
      to: ["tag:web-app", "@scope/app"],
      port: 46435,
    });
    assert.deepEqual(argv, [
      "rush",
      "start",
      "--to",
      "tag:web-app",
      "--to",
      "@scope/app",
      "--port",
      "46435",
    ]);
  });

  it("deduplicates a repeated selector while preserving first-seen order", () => {
    const argv = buildRushArgs({
      subcommand: "start",
      to: ["@scope/app", "@scope/feature", "@scope/app"],
    });
    assert.deepEqual(argv, ["rush", "start", "--to", "@scope/app", "--to", "@scope/feature"]);
  });

  it("omits --port when no port is given", () => {
    const argv = buildRushArgs({ subcommand: "build", to: ["@scope/app"] });
    assert.deepEqual(argv, ["rush", "build", "--to", "@scope/app"]);
  });

  it("appends extra args after the selectors and port", () => {
    const argv = buildRushArgs({
      subcommand: "start",
      to: ["@scope/app"],
      port: 46435,
      extra: ["--verbose"],
    });
    assert.deepEqual(argv, [
      "rush",
      "start",
      "--to",
      "@scope/app",
      "--port",
      "46435",
      "--verbose",
    ]);
  });

  it("rejects an empty closure to prevent an accidental full-monorepo build", () => {
    assert.throws(() => buildRushArgs({ subcommand: "start", to: [] }), /selector/i);
  });

  it("rejects a blank subcommand", () => {
    assert.throws(() => buildRushArgs({ subcommand: "  ", to: ["@scope/app"] }), /subcommand/i);
  });

  it("rejects a --port for a run-to-completion subcommand", () => {
    assert.throws(
      () => buildRushArgs({ subcommand: "build", to: ["@scope/app"], port: 46435 }),
      /takes no --port/i,
    );
  });

  it("rejects a non-integer or out-of-range port", () => {
    assert.throws(() => buildRushArgs({ subcommand: "start", to: ["@scope/app"], port: 0 }), /port/i);
    assert.throws(() => buildRushArgs({ subcommand: "start", to: ["@scope/app"], port: 70000 }), /port/i);
    assert.throws(() => buildRushArgs({ subcommand: "start", to: ["@scope/app"], port: 3.5 }), /port/i);
    assert.throws(() => buildRushArgs({ subcommand: "start", to: ["@scope/app"], port: Number.NaN }), /port/i);
  });
});

describe("rushReadyWhen", () => {
  it("returns the watch ready marker for a watch subcommand", () => {
    assert.equal(rushReadyWhen("start"), "log:Waiting for changes");
    assert.equal(rushReadyWhen("build-watch"), "log:Waiting for changes");
  });

  it("returns undefined for a run-to-completion subcommand", () => {
    assert.equal(rushReadyWhen("build"), undefined);
    assert.equal(rushReadyWhen("test"), undefined);
  });
});
