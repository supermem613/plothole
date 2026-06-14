import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPlotholeServer } from "../server.js";

// The debug client exercises the server IN-PROCESS over a linked in-memory
// transport instead of spawning `node dist/server.js`. The SDK stdio client
// launches the child with a stripped default environment, which breaks every
// verb that shells out to gh with ssh exit 255. Running in-process lets the
// verbs inherit this CLI process's full environment, so gh behaves exactly as
// it does for the CLI face. The real stdio boundary is owned by whatever MCP
// host registers the server, so it is not this debug command's job to prove.
async function withLocalMcpClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const server = createPlotholeServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "local-mcp-debug", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function mcpSchemaCommand(): Promise<void> {
  const response = await withLocalMcpClient((client) => client.listTools());
  process.stdout.write(`${JSON.stringify({ ok: true, command: "mcp-schema", data: response })}\n`);
}

export async function mcpCallCommand(tool: string, jsonArgs: string | undefined): Promise<void> {
  const args = parseJsonArgs(jsonArgs);
  const response = await withLocalMcpClient((client) => client.callTool({ name: tool, arguments: args }));
  process.stdout.write(`${JSON.stringify({ ok: true, command: "mcp-call", data: response })}\n`);
}

function parseJsonArgs(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("jsonArgs must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}
