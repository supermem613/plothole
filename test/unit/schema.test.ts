import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildSchema } from "../../src/registry.js";

describe("schema", () => {
  it("lists the baseline and MCP commands", () => {
    const schema = buildSchema("0.1.0") as { commands: Array<{ path: string[] }> };
    assert.deepEqual(schema.commands.map((command) => command.path), [
      ["doctor"],
      ["schema"],
      ["mcp-config"],
      ["mcp-server"],
      ["mcp-schema"],
      ["mcp-call"],
      ["update"],
      ["exec"],
      ["wait"],
      ["runs"],
      ["clean"],
      ["kill"],
      ["logs"],
      ["read"],
      ["search"],
      ["edit"],
      ["session"],
      ["env"],
      ["forward"],
      ["rush"],
    ]);
  });

  it("supports prefix filtering and summary output", () => {
    const schema = buildSchema("0.1.0", ["mcp"], true) as { commandCount: number; commandPaths: string[][] };
    assert.equal(schema.commandCount, 0);
    assert.deepEqual(schema.commandPaths, []);
  });

  it("supports exact command prefix filtering", () => {
    const schema = buildSchema("0.1.0", ["mcp-config"], true) as { commandCount: number; commandPaths: string[][] };
    assert.equal(schema.commandCount, 1);
    assert.deepEqual(schema.commandPaths, [["mcp-config"]]);
  });
});
