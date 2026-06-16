import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPlotholeServer } from "../../src/server.js";

describe("mcp server", () => {
  it("constructs without starting stdio transport", () => {
    const server = createPlotholeServer();
    assert.equal(typeof server, "object");
  });

  it("advertises the codespace world model and lifecycle to the client at handshake", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plothole-test", version: "0.0.0" });
    const server = createPlotholeServer();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const instructions = client.getInstructions();
      assert.equal(typeof instructions, "string");
      const text = instructions as string;
      assert.equal(text.length > 0, true);
      assert.match(text, /INSIDE the active codespace/);
      assert.match(text, /session tool \(ensure\)/);
      assert.match(text, /runId/);
      assert.match(text, /forward/);
      assert.match(text, /readyWhen/);
    } finally {
      await client.close();
    }
  });
});
