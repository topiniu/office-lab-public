// Host-owned tool definitions. Provider SDK objects stay inside the adapter.
import { z } from 'zod'
export function tool(name, description, shape, handler, extras = {}) {
  return { name, description, shape, handler, ...extras }
}
export function createToolServer({ name, version = '1.0.0', tools }) {
  return { type: 'lab', name, version, tools }
}
export function toolCatalog(servers = {}, allowedTools) {
  const catalog = new Map()
  for (const [serverName, server] of Object.entries(servers)) {
    if (server.type !== 'lab') continue
    for (const definition of server.tools) {
      const name = `mcp__${serverName}__${definition.name}`
      if (allowedTools && !allowedTools.includes(name)) continue
      const schema = z.object(definition.shape)
      if (catalog.has(name)) throw new Error(`Duplicate tool: ${name}`)
      catalog.set(name, {
        name, description: definition.description,
        inputSchema: z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'throw' }),
        async invoke(input, context = {}) {
          if (context.signal?.aborted) throw new Error('Tool call cancelled')
          const parsed = await schema.parseAsync(input)
          if (context.signal?.aborted) throw new Error('Tool call cancelled')
          return definition.handler(parsed, context)
        },
      })
    }
  }
  return catalog
}
