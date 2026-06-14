import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildMcpConfig } from "../../src/commands/mcpConfig.js";

describe("mcp-config", () => {
  it("emits Copilot CLI local server config", () => {
    assert.deepEqual(buildMcpConfig(), {
      mcpServers: {
        "plothole": {
          type: "local",
          command: "plothole",
          args: ["mcp-server"],
          tools: ["*"],
        },
      },
    });
  });
});
