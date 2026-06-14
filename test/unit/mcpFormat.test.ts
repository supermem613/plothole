import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { toolTextResult } from "../../src/mcp/format.js";

describe("mcp format", () => {
  it("wraps structured values as compact JSON text content", () => {
    assert.deepEqual(toolTextResult({ ok: true, data: { message: "pong" } }), {
      content: [
        {
          type: "text",
          text: "{\"ok\":true,\"data\":{\"message\":\"pong\"}}",
        },
      ],
    });
  });
});
