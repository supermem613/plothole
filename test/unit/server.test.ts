import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createPlotholeServer } from "../../src/server.js";

describe("mcp server", () => {
  it("constructs without starting stdio transport", () => {
    const server = createPlotholeServer();
    assert.equal(typeof server, "object");
  });
});
