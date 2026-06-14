import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { classifySpfxDeploy } from "../../src/core/spfxDeploy.js";

// A healthy SPFx rush start landing page advertises a real debug query
// string in the spfxDebugQueryString slot. The literal "(Not Deployed)" also
// shows up on a healthy page in unrelated demo/dev cards, so the classifier
// must read the specific element and never grep the page at large.
const HEALTHY = `
<section id="sp-client">
  <code id="spfxDebugQueryString">?debug=true&noredir=true&loader=https://localhost:46435/hashed/sp-loader-assembly_en-us_abc.js&debugManifestsFile=https://localhost:46435/dev/manifests.js</code>
</section>
<section id="demo-apps">
  <code>(Not Deployed)</code>
</section>
<section id="size-auditor">
  <code>(Not Deployed)</code>
</section>
`;

const NOT_DEPLOYED = `
<section id="sp-client">
  <code id="spfxDebugQueryString">(Not Deployed)</code>
</section>
`;

const MISSING = `
<section id="sp-client">
  <p>the page rendered without the debug query slot</p>
</section>
`;

describe("classifySpfxDeploy", () => {
  it("reports deployed when the debug query slot holds a real query string", () => {
    const status = classifySpfxDeploy(HEALTHY);
    assert.equal(status.deployed, true);
    assert.ok(status.debugQueryString?.startsWith("?debug=true"));
  });

  it("does not false-positive on the (Not Deployed) demo/size-auditor cards of a healthy page", () => {
    // The page carries the literal "(Not Deployed)" in other cards. A page-wide
    // scan would call a healthy server failed, so the classifier must stay scoped
    // to the spfxDebugQueryString element.
    const status = classifySpfxDeploy(HEALTHY);
    assert.equal(status.deployed, true);
  });

  it("reports not deployed when the debug query slot is the literal (Not Deployed)", () => {
    const status = classifySpfxDeploy(NOT_DEPLOYED);
    assert.equal(status.deployed, false);
    assert.match(status.reason, /Not Deployed/);
  });

  it("reports not deployed with a clear reason when the slot is missing", () => {
    const status = classifySpfxDeploy(MISSING);
    assert.equal(status.deployed, false);
    assert.match(status.reason, /spfxDebugQueryString/);
  });

  it("trims surrounding whitespace around the query string", () => {
    const padded = '<code id="spfxDebugQueryString">\n  ?debug=true&x=1\n</code>';
    const status = classifySpfxDeploy(padded);
    assert.equal(status.deployed, true);
    assert.equal(status.debugQueryString, "?debug=true&x=1");
  });
});
