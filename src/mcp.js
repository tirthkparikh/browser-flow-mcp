// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No SDK needed.
import { createInterface } from 'node:readline';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * serveStdio({ name, version, instructions, listTools, callTool })
 *   listTools(): Promise<Tool[]>
 *   callTool(name, args, { signal }): Promise<{ content, isError?, structuredContent? }>
 * Returns { notifyToolsChanged() }.
 */
export function serveStdio({ name, version, instructions, listTools, callTool, input = process.stdin, output = process.stdout }) {
  const write = msg => output.write(JSON.stringify(msg) + '\n');
  const running = new Map();  // request id -> AbortController
  let ready = false;

  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          return reply(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name, version },
            ...(instructions ? { instructions } : {}),
          });
        }
        case 'notifications/initialized': ready = true; return;
        case 'notifications/cancelled': running.get(params.requestId)?.abort(); return;
        case 'ping': return reply(id, {});
        case 'tools/list': return reply(id, { tools: await listTools() });
        case 'tools/call': {
          const ctrl = new AbortController();
          running.set(id, ctrl);
          try {
            const result = await callTool(params.name, params.arguments ?? {}, { signal: ctrl.signal });
            if (!ctrl.signal.aborted) reply(id, result);
          } finally { running.delete(id); }
          return;
        }
        case 'resources/list': return reply(id, { resources: [] });
        case 'prompts/list': return reply(id, { prompts: [] });
        default:
          if (isRequest) fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (isRequest) fail(id, e.code ?? -32603, e.message);
    }
  }

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  });

  return {
    notifyToolsChanged() { if (ready) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); },
    closed: new Promise(ok => rl.on('close', ok)),
  };
}
