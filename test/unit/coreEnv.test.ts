import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildEnvProbe } from "../../src/core/remote.js";

describe("buildEnvProbe", () => {
  it("probes the core toolchain and omits install state by default", () => {
    const probe = buildEnvProbe(false);
    assert.match(probe, /node --version/);
    assert.match(probe, /rush --version/);
    assert.match(probe, /rg --version/);
    assert.doesNotMatch(probe, /node_modules/);
  });

  it("adds install-state checks when requested", () => {
    const probe = buildEnvProbe(true);
    assert.match(probe, /node_modules/);
    assert.match(probe, /common\/temp/);
  });
});
