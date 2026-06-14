import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { isSshTransportError, retryOnSshDrop } from "../../src/core/transport.js";
import type { ProcessResult } from "../../src/core/gh.js";

const DROP = 'failed to invoke SSH RPC: connection error: "error reading server preface: read tcp ... use of closed network connection"';

describe("isSshTransportError", () => {
  it("matches known transport-establishment failures", () => {
    assert.ok(isSshTransportError("error reading server preface"));
    assert.ok(isSshTransportError("use of closed network connection"));
    assert.ok(isSshTransportError("error getting ssh server details"));
    assert.ok(isSshTransportError("failed to invoke SSH RPC"));
  });

  it("ignores ordinary command stderr", () => {
    assert.ok(!isSshTransportError("error: cannot find module 'foo'"));
    assert.ok(!isSshTransportError(""));
  });
});

describe("retryOnSshDrop", () => {
  const ok: ProcessResult = { stdout: "out", stderr: "", code: 0 };
  const drop: ProcessResult = { stdout: "", stderr: DROP, code: 1 };

  it("retries a transport drop until it succeeds", async () => {
    let calls = 0;
    const result = await retryOnSshDrop(
      () => {
        calls += 1;
        return Promise.resolve(calls < 3 ? drop : ok);
      },
      () => false,
    );
    assert.equal(calls, 3);
    assert.equal(result.code, 0);
  });

  it("stops after the attempt cap and returns the last failure", async () => {
    let calls = 0;
    const result = await retryOnSshDrop(() => {
      calls += 1;
      return Promise.resolve(drop);
    }, () => false);
    assert.equal(calls, 3);
    assert.equal(result.code, 1);
  });

  it("does not retry when the remote already produced output", async () => {
    let calls = 0;
    await retryOnSshDrop(
      () => {
        calls += 1;
        return Promise.resolve({ stdout: "SENTINEL", stderr: DROP, code: 1 });
      },
      () => true,
    );
    assert.equal(calls, 1);
  });

  it("does not retry an ordinary nonzero command failure", async () => {
    let calls = 0;
    await retryOnSshDrop(
      () => {
        calls += 1;
        return Promise.resolve({ stdout: "", stderr: "build failed: tsc error", code: 2 });
      },
      () => false,
    );
    assert.equal(calls, 1);
  });
});
