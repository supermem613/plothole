export function buildMcpConfig() {
  return {
    mcpServers: {
      "plothole": {
        type: "local",
        command: "plothole",
        args: ["mcp-server"],
        tools: ["*"],
      },
    },
  };
}

export async function mcpConfigCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildMcpConfig(), null, 2)}\n`);
}
