#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFlow, loadFlows, runFlow, inputSchema, STEPS } from '../src/flow.js';
import { startServer } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, '../package.json'), 'utf8'));
process.env.npm_package_version = pkg.version;

const HELP = `browser-flow-mcp ${pkg.version}
Write a browser task once in YAML. Run it from the terminal or cron, or let AI agents call it as an MCP tool.

Usage
  browser-flow-mcp init [dir]              Create example flows        (default dir: flows)
  browser-flow-mcp run <flow.yml> [k=v…]   Run one flow and print the result as JSON
  browser-flow-mcp serve <dir>             MCP server (stdio): every flow becomes a tool
  browser-flow-mcp list <dir>              Show the tools a folder provides
  browser-flow-mcp check <dir|file>        Validate flows without running them
  browser-flow-mcp steps                   List the available step types

Run options
  --headed                 Show the browser window
  --out <file>             Also write the JSON result to a file
  --every <30s|15m|2h>     Repeat on a schedule (keeps running)
  --webhook <url>          POST each result as JSON to this URL (Slack, n8n, Zapier…)
  --quiet                  Only print the result

Serve options
  --headed                 Show the browser window while tools run

Claude Desktop / Cursor / Claude Code config:
  { "mcpServers": { "browser-flows": { "command": "npx", "args": ["-y", "@tirthlabs/browser-flow-mcp", "serve", "/abs/path/to/flows"] } } }

Docs: ${pkg.homepage}`;

const fail = msg => { console.error(`\x1b[31m✖\x1b[0m ${msg}`); process.exit(1); };

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      headed: { type: 'boolean' }, out: { type: 'string', short: 'o' }, every: { type: 'string' },
      webhook: { type: 'string' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
} catch (e) { fail(`${e.message}\nRun browser-flow-mcp --help`); }
const { values: flags, positionals: [command, target, ...rest] } = parsed;
if (flags.version) { console.log(pkg.version); process.exit(0); }
if (flags.help || !command) { console.log(HELP); process.exit(flags.help ? 0 : 1); }

const parseEvery = s => {
  const m = String(s).match(/^(\d+)\s*(s|m|h|d)$/);
  if (!m || Number(m[1]) === 0) fail(`--every expects e.g. 30s, 15m, 2h or 1d (got "${s}")`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
};

async function runOnce(flow, inputs) {
  const res = await runFlow(flow, { inputs, headless: !flags.headed, onLog: flags.quiet ? undefined : m => console.error(`  ${m}`) });
  const result = { flow: flow.name, ok: res.ok, at: new Date().toISOString(), ms: res.ms, ...(res.ok ? { output: res.output } : { error: res.error, failedStep: res.failedStep, url: res.url }), files: res.files };
  const shot = !res.ok && res.images.find(i => i.label === 'page at failure');
  if (shot) {
    // save the failure screenshot next to the result so cron runs can be debugged later
    const file = resolve(flags.out ? dirname(resolve(flags.out)) : '.', `${flow.name}-failure-${Date.now()}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    result.screenshot = file;
  }
  console.log(JSON.stringify(result, null, 2));
  if (flags.out) { await mkdir(dirname(resolve(flags.out)), { recursive: true }); await writeFile(flags.out, JSON.stringify(result, null, 2) + '\n'); }
  if (flags.webhook) {
    try {
      const r = await fetch(flags.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
      if (!r.ok) console.error(`\x1b[33m!\x1b[0m webhook answered ${r.status}`);
    } catch (e) { console.error(`\x1b[33m!\x1b[0m webhook failed: ${e.message}`); }
  }
  return res.ok;
}

try {
  switch (command) {
    case 'init': {
      const dir = target ?? 'flows';
      await mkdir(dir, { recursive: true });
      const src = join(here, '../examples');
      for (const f of await readdir(src)) {
        const dest = join(dir, f);
        try { await access(dest); console.log(`  skipped ${dest} (exists)`); continue; } catch {}
        await copyFile(join(src, f), dest);
        console.log(`\x1b[32m✔\x1b[0m ${dest}`);
      }
      console.log(`\nTry:  npx @tirthlabs/browser-flow-mcp run ${dir}/hn-top.yml limit=5\nMCP:  npx @tirthlabs/browser-flow-mcp serve ${resolve(dir)}`);
      break;
    }
    case 'run': {
      if (!target) fail('Usage: browser-flow-mcp run <flow.yml> [name=value ...]');
      const flow = await loadFlow(target);
      const inputs = {};
      for (const kv of rest) {
        const i = kv.indexOf('=');
        if (i < 1) fail(`Inputs look like name=value (got "${kv}")`);
        inputs[kv.slice(0, i)] = kv.slice(i + 1);
      }
      if (!flags.every) { process.exitCode = (await runOnce(flow, inputs)) ? 0 : 1; break; }
      const ms = parseEvery(flags.every);
      console.error(`  running "${flow.name}" every ${flags.every}. Ctrl+C to stop.`);
      const loop = async () => { await runOnce(flow, inputs).catch(e => console.error(e.message)); setTimeout(loop, ms); };
      await loop();
      break;
    }
    case 'serve': {
      if (!target) fail('Usage: browser-flow-mcp serve <flows-folder>');
      const { flows, errors } = await loadFlows(target);
      errors.forEach(e => console.error(`[browser-flow-mcp] skipped: ${e}`));
      console.error(`[browser-flow-mcp] serving ${flows.length} flow(s) from ${resolve(target)}: ${flows.map(f => f.name).join(', ')}`);
      startServer({ dir: target, headless: !flags.headed });
      break;
    }
    case 'list':
    case 'check': {
      if (!target) fail(`Usage: browser-flow-mcp ${command} <folder or file>`);
      const { flows, errors } = await loadFlows(target);
      for (const f of flows) {
        const props = inputSchema(f).properties;
        const ins = Object.entries(props).map(([k, p]) => `${k}: ${p.type}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}`).join(', ');
        console.log(`\x1b[32m✔\x1b[0m ${f.name}(${ins})${command === 'list' ? `\n    ${f.description ?? ''}` : ` (${f.steps.length} steps)`}`);
      }
      errors.forEach(e => console.error(`\x1b[31m✖\x1b[0m ${e}`));
      if (!flows.length && !errors.length) console.error('No .yml or .yaml flows found.');
      process.exitCode = errors.length ? 1 : 0;
      break;
    }
    case 'steps':
      for (const [k, d] of Object.entries(STEPS)) console.log(`  ${k.padEnd(11)} ${d}`);
      break;
    default:
      fail(`Unknown command "${command}". Run browser-flow-mcp --help`);
  }
} catch (e) { fail(e.message); }
