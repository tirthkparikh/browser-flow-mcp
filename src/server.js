// Expose a folder of browser flows as MCP tools.
import { watch } from 'node:fs';
import { loadFlows, inputSchema, runFlow, browserPool } from './flow.js';
import { serveStdio } from './mcp.js';

export function toolFor(flow) {
  return {
    name: flow.name,
    title: flow.title ?? flow.name.replace(/[_-]+/g, ' '),
    description: [flow.description ?? `Browser flow "${flow.name}"`, flow.returns ? `Returns: ${flow.returns}` : ''].filter(Boolean).join('\n'),
    inputSchema: inputSchema(flow),
    annotations: { readOnlyHint: !!flow.readOnly, openWorldHint: true },
  };
}

/** Format a run result as MCP tool content. */
export function toContent(flow, res) {
  const content = [];
  if (res.ok) {
    content.push({ type: 'text', text: JSON.stringify(res.output, null, 2) });
    if (res.files.length) content.push({ type: 'text', text: `Files saved:\n${res.files.join('\n')}` });
  } else {
    content.push({ type: 'text', text: `Flow "${flow.name}" failed at step ${res.failedStep}: ${res.error}\nPage: ${res.url ?? '-'}\nLog:\n${res.log.join('\n')}` });
  }
  for (const img of res.images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  const out = { content, isError: !res.ok };
  if (res.ok && res.output && typeof res.output === 'object' && !Array.isArray(res.output)) out.structuredContent = res.output;
  return out;
}

export function startServer({ dir, headless = true, log = m => process.stderr.write(m + '\n') }) {
  const pool = browserPool({ headless });
  let cache = null;
  const flows = async () => {
    if (!cache) {
      cache = loadFlows(dir).then(r => {
        for (const e of r.errors) log(`[browser-flow-mcp] skipped: ${e}`);
        return r.flows;
      });
    }
    return cache;
  };

  const server = serveStdio({
    name: 'browser-flow-mcp',
    version: process.env.npm_package_version ?? '1.0.0',
    instructions: 'Each tool runs a pre-written browser flow (Playwright). Call the tool with its inputs; results come back as JSON, with screenshots when the flow takes them.',
    listTools: async () => (await flows()).map(toolFor),
    callTool: async (name, args, { signal }) => {
      const flow = (await flows()).find(f => f.name === name);
      if (!flow) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
      log(`[browser-flow-mcp] run ${name} ${JSON.stringify(args)}`);
      try {
        const res = await runFlow(flow, { inputs: args, pool, signal });
        log(`[browser-flow-mcp] ${name}: ${res.ok ? 'ok' : 'failed: ' + res.error} (${res.ms}ms)`);
        return toContent(flow, res);
      } catch (e) {
        // input validation errors
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    },
  });

  let t;
  try {
    watch(dir, () => { clearTimeout(t); t = setTimeout(() => { cache = null; server.notifyToolsChanged(); }, 200); });
  } catch {}

  const shutdown = async () => { await pool.close(); process.exit(0); };
  server.closed.then(shutdown);
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  return server;
}
