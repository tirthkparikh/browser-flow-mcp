import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runFlow, validate, inputSchema, render, browserPool } from '../src/flow.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/cli.js');

// A tiny fake "supplier portal": login, an orders table with 2 pages, and a CSV download.
const PAGES = {
  '/login': `<form action="/orders" method="get"><input name="email"><input type="password" name="pw"><button type="submit">Sign in</button></form>`,
  '/orders': `<h1>Orders</h1><table>
    <tr class="row"><td class="id">A-1</td><td class="price">$120.50</td></tr>
    <tr class="row"><td class="id">A-2</td><td class="price">$80.00</td></tr></table>
    <select id="status"><option value="all">All</option><option value="paid">Paid</option></select>
    <label><input type="checkbox" id="agree"> agree</label>
    <a href="/orders2" class="next">Next</a>
    <a href="/export.csv" download id="export">Export CSV</a>`,
  '/orders2': `<h1>Orders page 2</h1><table><tr class="row"><td class="id">A-3</td><td class="price">$9.99</td></tr></table>`,
};
let server, base, pool;
before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/export.csv') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="orders.csv"' }); return res.end('id,price\nA-1,120.50\n'); }
    if (!PAGES[path]) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Portal</title><body>${PAGES[path]}</body>`);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
  pool = browserPool();
});
after(async () => { await pool.close(); server.close(); });

test('render: variables, env vars and whole-value passthrough', () => {
  process.env.BF_TEST_SECRET = 's3cret';
  assert.equal(render('{{a.b}}', { a: { b: 5 } }), 5);
  assert.equal(render('id={{a.b}}&k=${BF_TEST_SECRET}', { a: { b: 5 } }), 'id=5&k=s3cret');
  assert.deepEqual(render({ x: ['{{list}}'] }, { list: [1, 2] }), { x: [[1, 2]] });
  assert.throws(() => render('{{missing}}', {}), /Unknown variable \{\{missing\}\}/);
  assert.throws(() => render('${NOPE_NOT_SET_X}', {}), /NOPE_NOT_SET_X is not set/);
});

test('validate catches bad flows', () => {
  assert.deepEqual(validate({ name: 'ok', steps: [{ goto: 'x' }] }), []);
  const errs = validate({ name: 'bad name!', steps: [{ goto: 'x', click: 'y' }, { teleport: 1 }, { if: 'x' }], inputs: { a: 'date' } });
  assert.equal(errs.length, 5, errs.join('\n'));
});

test('inputSchema: required unless default/optional', () => {
  const s = inputSchema({ inputs: { a: 'string', b: { type: 'integer', default: 3 }, c: { type: 'string', optional: true, enum: ['x', 'y'] } } });
  assert.deepEqual(s.required, ['a']);
  assert.equal(s.properties.b.default, 3);
  assert.deepEqual(s.properties.c.enum, ['x', 'y']);
});

test('full flow: login, form controls, extract table, pagination, download, assert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-'));
  process.env.BF_PW = 'hunter2';
  const flow = {
    name: 'orders', file: join(dir, 'orders.yml'),
    inputs: { email: 'string', pages: { type: 'integer', default: 2 } },
    steps: [
      { goto: `${base}/login` },
      { fill: { 'input[name=email]': '{{email}}', 'input[type=password]': '${BF_PW}' } },
      { click: 'button[type=submit]' },
      { wait: { url: '/orders' } },
      { assert: { textContains: 'Orders', selector: 'h1' } },
      { select: { selector: '#status', value: 'paid' } },
      { check: '#agree' },
      { eval: "document.querySelector('#status').value + ':' + document.querySelector('#agree').checked", as: 'form' },
      { extract: { rows: { selector: 'tr.row', fields: { id: '.id', price: { selector: '.price' } } }, first: { selector: '.price', number: true } } },
      { download: { click: '#export', saveAs: 'out/orders.csv' }, as: 'csv' },
      { click: 'text=Does not exist', optional: true, timeout: 300 },
      { if: { visible: 'a.next' }, then: [{ click: 'a.next' }, { extract: { page2: { selector: 'tr.row .id', all: true } } }], else: [{ log: 'no next page' }] },
      { screenshot: { path: 'out/page2.png' } },
    ],
    output: { form: '{{form}}', rows: '{{rows}}', first: '{{first}}', page2: '{{page2}}', csv: '{{csv}}' },
  };
  const res = await runFlow(flow, { inputs: { email: 'me@example.com' }, pool });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.output.form, 'paid:true');
  assert.deepEqual(res.output.rows, [{ id: 'A-1', price: '$120.50' }, { id: 'A-2', price: '$80.00' }]);
  assert.equal(res.output.first, 120.5);
  assert.deepEqual(res.output.page2, ['A-3']);
  assert.equal(await readFile(join(dir, 'out/orders.csv'), 'utf8'), 'id,price\nA-1,120.50\n');
  assert.ok((await stat(join(dir, 'out/page2.png'))).size > 1000);
  assert.ok(res.log.some(l => l.startsWith('- skipped click')));
});

test('repeat with while condition (pagination loop)', async () => {
  const res = await runFlow({
    name: 'loop',
    steps: [
      { goto: `${base}/orders` },
      { set: { seen: 0 } },
      { repeat: { max: 5, while: { visible: 'a.next' }, steps: [{ log: 'page {{index}}' }, { click: 'a.next' }] } },
      { extract: { heading: 'h1' } },
    ],
  }, { pool });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.output.heading, 'Orders page 2');
  assert.deepEqual(res.log.filter(l => l.startsWith('page')), ['page 0']);
});

test('failures report the step, the URL and a screenshot', async () => {
  const res = await runFlow({ name: 'broken', timeout: 500, steps: [{ goto: `${base}/orders` }, { click: '#nope' }] }, { pool });
  assert.equal(res.ok, false);
  assert.match(res.failedStep, /^#2 click #nope/);
  assert.match(res.url, /\/orders$/);
  assert.equal(res.images.at(-1).label, 'page at failure');
  await assert.rejects(runFlow({ name: 'x', inputs: { q: 'string' }, steps: [{ goto: base }] }, { pool }), /Missing input "q"/);
});

// Talk to the real CLI over stdio like Claude Desktop would.
function mcpClient(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map(), notes = [];
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else notes.push(msg);
    }
  });
  return {
    notes,
    request: (method, params) => new Promise(ok => { const n = ++id; waiting.set(n, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); }),
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    close: () => new Promise(ok => { child.on('exit', ok); child.stdin.end(); }),
  };
}

test('MCP server over stdio: initialize, list tools, call a tool, hot reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-mcp-'));
  await writeFile(join(dir, 'orders.yml'), YAML.stringify({
    name: 'get_orders', description: 'List orders', readOnly: true, inputs: { status: { type: 'string', enum: ['all', 'paid'], default: 'all' } },
    steps: [{ goto: `${base}/orders?s={{status}}` }, { extract: { ids: { selector: '.id', all: true } } }],
  }));
  const c = mcpClient(['serve', dir]);
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'browser-flow-mcp');
    c.notify('notifications/initialized');

    const list = await c.request('tools/list', {});
    assert.equal(list.result.tools.length, 1);
    const tool = list.result.tools[0];
    assert.equal(tool.name, 'get_orders');
    assert.deepEqual(tool.inputSchema.properties.status.enum, ['all', 'paid']);
    assert.equal(tool.annotations.readOnlyHint, true);

    const call = await c.request('tools/call', { name: 'get_orders', arguments: { status: 'paid' } });
    assert.equal(call.result.isError, false);
    assert.deepEqual(JSON.parse(call.result.content[0].text), { ids: ['A-1', 'A-2'] });
    assert.deepEqual(call.result.structuredContent, { ids: ['A-1', 'A-2'] });

    const bad = await c.request('tools/call', { name: 'get_orders', arguments: { status: 'nope' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /must be one of/);
    const unknown = await c.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);

    await writeFile(join(dir, 'second.yml'), YAML.stringify({ name: 'second', steps: [{ goto: base }] }));
    await new Promise(r => setTimeout(r, 800));
    assert.ok(c.notes.some(n => n.method === 'notifications/tools/list_changed'));
    assert.equal((await c.request('tools/list', {})).result.tools.length, 2);
  } finally { await c.close(); }
});

test('onContext can block requests before the page opens', async () => {
  const res = await runFlow({ name: 'blocked', timeout: 2000, steps: [{ goto: `${base}/orders` }] }, {
    pool, onContext: ctx => ctx.route('**/orders', route => route.abort('blockedbyclient')),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /ERR_BLOCKED_BY_CLIENT/);
});

test('QA fixes: eval keeps ${}, $${X} escape, optional covers render errors, HTTP errors, inputs', async () => {
  assert.equal(render('a $${HOME} b', {}), 'a ${HOME} b');
  const res = await runFlow({ name: 'qa', steps: [
    { goto: `${base}/orders` },
    { eval: 'const x = 2; return `n=${x}`', as: 'n' },
    { log: '${SURELY_NOT_SET_ENV_VAR}', optional: true },
    { goto: { url: `${base}/missing`, allowHttpErrors: true } },
    { set: { code: '{{status}}' } },
  ] }, { pool });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.n, 'n=2');
  const bad = await runFlow({ name: 'qa404', steps: [{ goto: `${base}/missing` }] }, { pool });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /HTTP 404/);
  assert.doesNotMatch(bad.error, /\x1b\[/);
  const int = { name: 'i', inputs: { n: { type: 'integer' }, s: { type: 'string', default: 'd' } }, steps: [{ goto: `${base}/orders` }] };
  await assert.rejects(runFlow(int, { pool, inputs: { n: '1.5' } }), /whole number/);
  const empty = await runFlow({ ...int, output: { s: '{{s}}' } }, { pool, inputs: { n: 1, s: '' } });
  assert.equal(empty.output.s, '');
});

test('MCP server answers in-flight calls before exiting on stdin close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-eof-'));
  await writeFile(join(dir, 'slow.yml'), `name: slow\nsteps:\n  - goto: ${base}/orders\n  - wait: 300\n`);
  const child = spawn(process.execPath, [CLI, 'serve', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n');
  await new Promise(ok => child.on('exit', ok));
  const replies = out.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(replies.some(r => r.id === 2 && r.result), 'tools/call reply missing');
});
