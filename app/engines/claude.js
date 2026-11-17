export async function* claudeQuery({ prompt, options }) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const { engine, engineConfig, readOnly, codeLocked, protectedCodeRoots, requestApproval, requestUserInput, codexOwnerDirectory, ...sdkOptions } = options
  if (options.mcpServers) {
    sdkOptions.mcpServers = Object.fromEntries(Object.entries(options.mcpServers).map(([name, server]) => [name,
      server.type === 'lab' ? sdk.createSdkMcpServer({
        name: server.name, version: server.version,
        tools: server.tools.map(t => sdk.tool(t.name, t.description, t.shape, t.handler, t.annotations ? { annotations: t.annotations } : undefined)),
      }) : server,
    ]))
  }
  yield* sdk.query({ prompt, options: sdkOptions })
}
