// Browser flows: small YAML files that describe a browser task step by step.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, dirname, resolve as resolvePath, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const STEPS = {
  goto: 'Open a URL',
  click: 'Click an element',
  dblclick: 'Double-click an element',
  fill: 'Fill one or more inputs ({ selector: value })',
  type: 'Type text key by key',
  press: 'Press a key, e.g. Enter',
  select: 'Choose an option in a <select>',
  check: 'Tick a checkbox',
  uncheck: 'Untick a checkbox',
  hover: 'Hover an element',
  upload: 'Attach files to a file input',
  scroll: 'Scroll to the bottom, top or an element',
  wait: 'Wait for ms, a selector, a URL or text',
  extract: 'Read text, attributes or lists into variables',
  screenshot: 'Save a screenshot (or return it to the AI)',
  pdf: 'Save the page as PDF (Chromium)',
  download: 'Click something and save the downloaded file',
  eval: 'Run JavaScript in the page',
  assert: 'Fail the flow unless a condition holds',
  set: 'Set variables',
  if: 'Run steps only when a condition holds',
  repeat: 'Repeat steps, e.g. for pagination',
  log: 'Write a message to the run log',
};

// ---------- templates ----------

function lookup(vars, path) {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), vars);
}

/** "{{a.b}}" -> value, "x {{a}} y" -> string, "${ENV}" -> env var. Recurses into arrays/objects. */
export function render(value, vars) {
  if (typeof value === 'string') {
    const env = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
      if (process.env[k] == null) throw new Error(`Environment variable ${k} is not set`);
      return process.env[k];
    });
    const whole = env.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (whole) {
      const v = lookup(vars, whole[1]);
      if (v === undefined) throw new Error(`Unknown variable {{${whole[1]}}}`);
      return v;
    }
    return env.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => {
      const v = lookup(vars, k);
      if (v === undefined) throw new Error(`Unknown variable {{${k}}}`);
      return isObj(v) || Array.isArray(v) ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => render(v, vars));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, vars)]));
  return value;
}

// ---------- loading & validation ----------

const INPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

export function validate(flow, where = 'flow') {
  const errors = [];
  if (!isObj(flow)) return [`${where}: must be a YAML object`];
  if (!flow.name || !NAME_RE.test(flow.name)) errors.push(`${where}: "name" must use letters, numbers, _ or - (max 64)`);
  if (!Array.isArray(flow.steps) || !flow.steps.length) errors.push(`${where}: "steps" must be a non-empty list`);
  for (const [k, spec] of Object.entries(flow.inputs ?? {})) {
    const type = isObj(spec) ? spec.type ?? 'string' : spec;
    if (!INPUT_TYPES.has(type)) errors.push(`${where}: input "${k}" has unknown type "${type}"`);
  }
  const walk = (steps, path) => steps?.forEach((step, i) => {
    const at = `${where}: ${path}[${i}]`;
    if (!isObj(step)) return errors.push(`${at} must be an object like { click: "#submit" }`);
    const keys = Object.keys(step).filter(k => !['as', 'optional', 'timeout', 'then', 'else', 'name'].includes(k));
    if (keys.length !== 1) return errors.push(`${at} must have exactly one action, found: ${keys.join(', ') || 'none'}`);
    if (!(keys[0] in STEPS)) return errors.push(`${at}: unknown step "${keys[0]}". Known: ${Object.keys(STEPS).join(', ')}`);
    if (keys[0] === 'if') { walk(step.then, `${path}[${i}].then`); walk(step.else, `${path}[${i}].else`); if (!Array.isArray(step.then)) errors.push(`${at}: "if" needs a "then" list`); }
    if (keys[0] === 'repeat') { if (!Array.isArray(step.repeat?.steps)) errors.push(`${at}: "repeat" needs a "steps" list`); walk(step.repeat?.steps, `${path}[${i}].repeat.steps`); }
  });
  walk(flow.steps, 'steps');
  return errors;
}

export async function loadFlow(file) {
  const text = await readFile(file, 'utf8');
  let flow;
  try { flow = YAML.parse(text); } catch (e) { throw new Error(`${file}: invalid YAML: ${e.message}`); }
  const errors = validate(flow, file);
  if (errors.length) throw new Error(errors.join('\n'));
  flow.file = resolvePath(file);
  return flow;
}

/** Load every *.yml / *.yaml flow in a folder (or a single file). Returns { flows, errors }. */
export async function loadFlows(target) {
  const flows = [], errors = [];
  let files;
  try {
    files = (await readdir(target)).filter(f => ['.yml', '.yaml'].includes(extname(f))).sort().map(f => join(target, f));
  } catch (e) {
    if (e.code === 'ENOTDIR') files = [target];
    else throw new Error(`Can't read ${target}: ${e.message}`);
  }
  const names = new Set();
  for (const f of files) {
    try {
      const flow = await loadFlow(f);
      if (names.has(flow.name)) throw new Error(`${f}: duplicate flow name "${flow.name}"`);
      names.add(flow.name);
      flows.push(flow);
    } catch (e) { errors.push(e.message); }
  }
  return { flows, errors };
}

/** JSON Schema for the flow's inputs (used as the MCP tool inputSchema). */
export function inputSchema(flow) {
  const properties = {}, required = [];
  for (const [k, spec] of Object.entries(flow.inputs ?? {})) {
    const s = isObj(spec) ? spec : { type: spec };
    const prop = { type: s.type ?? 'string' };
    if (s.description) prop.description = s.description;
    if (s.enum) prop.enum = s.enum;
    if (s.default !== undefined) prop.default = s.default;
    if (prop.type === 'array') prop.items = s.items ?? { type: 'string' };
    properties[k] = prop;
    if (s.required || (s.required === undefined && s.default === undefined && !s.optional)) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function coerceInputs(flow, given = {}) {
  const schema = inputSchema(flow);
  const out = {};
  for (const [k, prop] of Object.entries(schema.properties)) {
    let v = given[k];
    if (v === undefined || v === '') v = prop.default;
    if (v === undefined) {
      if (schema.required?.includes(k)) throw new Error(`Missing input "${k}"${prop.description ? ` (${prop.description})` : ''}`);
      continue;
    }
    if (typeof v === 'string' && prop.type !== 'string') {
      if (prop.type === 'number' || prop.type === 'integer') v = Number(v);
      else if (prop.type === 'boolean') v = /^(true|1|yes)$/i.test(v);
      else { try { v = JSON.parse(v); } catch { v = prop.type === 'array' ? v.split(',').map(s => s.trim()) : v; } }
    }
    if ((prop.type === 'number' || prop.type === 'integer') && !Number.isFinite(v)) throw new Error(`Input "${k}" must be a number`);
    if (prop.enum && !prop.enum.includes(v)) throw new Error(`Input "${k}" must be one of: ${prop.enum.join(', ')}`);
    out[k] = v;
  }
  for (const k of Object.keys(given)) if (!(k in schema.properties)) throw new Error(`Unknown input "${k}". Inputs: ${Object.keys(schema.properties).join(', ') || 'none'}`);
  return out;
}

// ---------- running ----------

let playwright;
async function getPlaywright() {
  if (playwright) return playwright;
  try { playwright = await import('playwright'); } catch {
    try { playwright = await import('playwright-core'); } catch {
      throw new Error('Playwright is not installed. Run: npm i playwright && npx playwright install chromium');
    }
  }
  return playwright;
}

export const sessionDir = () => process.env.BROWSER_FLOW_SESSIONS || join(homedir(), '.browser-flow', 'sessions');

/** Shared browser launcher so the MCP server reuses one browser between calls. */
export function browserPool({ headless = true } = {}) {
  const browsers = new Map();
  return {
    async get(type = 'chromium', opts = {}) {
      const key = `${type}:${opts.headless ?? headless}:${opts.channel ?? ''}`;
      if (!browsers.has(key)) {
        const pw = await getPlaywright();
        if (!pw[type]) throw new Error(`Unknown browser "${type}". Use chromium, firefox or webkit.`);
        const p = pw[type].launch({ headless: opts.headless ?? headless, channel: opts.channel }).catch(e => {
          browsers.delete(key);
          if (/Executable doesn't exist|browserType.launch/.test(e.message)) throw new Error(`${type} isn't installed. Run: npx playwright install ${type}`);
          throw e;
        });
        browsers.set(key, p);
      }
      const b = await browsers.get(key);
      if (!b.isConnected()) { browsers.delete(key); return this.get(type, opts); }
      return b;
    },
    async close() { for (const p of browsers.values()) await (await p.catch(() => null))?.close().catch(() => {}); browsers.clear(); },
  };
}

const describe = step => {
  const [k] = Object.keys(step).filter(x => x in STEPS);
  const v = step[k];
  return `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`.replace(/\s+/g, ' ').slice(0, 100);
};

/**
 * Run a flow. Returns { ok, data, output, files, images, log, ms, error?, failedStep? }.
 * opts: inputs, headless, pool (from browserPool), baseDir (for relative paths), images (collect screenshots as base64).
 */
export async function runFlow(flow, opts = {}) {
  const t0 = Date.now();
  const vars = { ...(flow.vars ?? {}), ...coerceInputs(flow, opts.inputs) };
  const data = {}, files = [], images = [], log = [];
  const baseDir = opts.baseDir ?? (flow.file ? dirname(flow.file) : process.cwd());
  const outPath = p => (isAbsolute(p) ? p : join(baseDir, p));
  const ownPool = !opts.pool;
  const pool = opts.pool ?? browserPool({ headless: opts.headless ?? flow.headless ?? true });
  const timeout = flow.timeout ?? 15000;
  let context, page, stepNo = 0, current = null;

  const sessionFile = flow.session ? join(sessionDir(), `${String(flow.session).replace(/[^\w-]/g, '_')}.json`) : null;
  const say = msg => { log.push(msg); opts.onLog?.(msg); };

  try {
    const browser = await pool.get(flow.browser ?? 'chromium', { headless: opts.headless ?? flow.headless, channel: flow.channel });
    let storageState;
    if (sessionFile) { try { await readFile(sessionFile); storageState = sessionFile; } catch {} }
    context = await browser.newContext({
      viewport: flow.viewport ?? { width: 1280, height: 800 }, userAgent: flow.userAgent, locale: flow.locale,
      acceptDownloads: true, storageState, ignoreHTTPSErrors: !!flow.ignoreHTTPSErrors,
    });
    context.setDefaultTimeout(timeout);
    page = await context.newPage();

    const loc = (sel, step = {}) => {
      let l = page.locator(String(sel));
      if (step.nth != null) l = l.nth(step.nth); else l = l.first();
      return l;
    };
    const target = (v, key = 'selector') => (isObj(v) ? v[key] : v);

    const check = async cond => {
      if (typeof cond === 'string') cond = { visible: cond };
      if (cond.visible) return page.locator(cond.visible).first().isVisible();
      if (cond.hidden) return !(await page.locator(cond.hidden).first().isVisible());
      if (cond.exists) return (await page.locator(cond.exists).count()) > 0;
      if (cond.url) return page.url().includes(cond.url);
      if (cond.text) return (await page.getByText(cond.text).count()) > 0;
      if (cond.equals) return String(cond.equals[0]) === String(cond.equals[1]);
      if ('truthy' in cond) return !!cond.truthy && cond.truthy !== 'false';
      throw new Error('Condition needs one of: visible, hidden, exists, url, text, equals, truthy');
    };

    const extractOne = async (spec) => {
      if (typeof spec === 'string') spec = { selector: spec };
      const read = async el => {
        if (spec.attr) return el.getAttribute(spec.attr);
        if (spec.html) return el.innerHTML();
        if (spec.value) return el.inputValue();
        return ((await el.innerText()) ?? '').trim();
      };
      if (spec.fields) {
        const rows = await page.locator(spec.selector).all();
        const out = [];
        for (const row of rows.slice(0, spec.limit ?? 500)) {
          const item = {};
          for (const [name, f] of Object.entries(spec.fields)) {
            const fs = typeof f === 'string' ? { selector: f } : f;
            const el = fs.selector ? row.locator(fs.selector).first() : row;
            item[name] = (await el.count()) ? await (async () => {
              if (fs.attr) return el.getAttribute(fs.attr);
              if (fs.html) return el.innerHTML();
              return ((await el.innerText()) ?? '').trim();
            })() : null;
          }
          out.push(item);
        }
        return out;
      }
      if (spec.all) {
        const els = await page.locator(spec.selector).all();
        const out = [];
        for (const el of els.slice(0, spec.limit ?? 500)) out.push(await read(el));
        return out;
      }
      if (spec.title) return page.title();
      if (spec.url) return page.url();
      const el = page.locator(spec.selector).first();
      await el.waitFor({ state: 'attached', timeout: spec.timeout ?? timeout });
      const v = await read(el);
      return spec.number ? Number(String(v).replace(/[^\d.-]/g, '')) : v;
    };

    const runSteps = async steps => {
      for (const raw of steps) {
        stepNo++;
        current = raw;
        const action = Object.keys(raw).find(k => k in STEPS);
        // nested steps are rendered when they run, so {{index}} etc. resolve per iteration
        const v = action === 'repeat' ? raw.repeat : render(raw[action], vars);
        const stepTimeout = raw.timeout ?? timeout;
        const t = Date.now();
        try {
          switch (action) {
            case 'goto': await page.goto(target(v, 'url'), { waitUntil: (isObj(v) && v.waitUntil) || 'domcontentloaded', timeout: stepTimeout }); break;
            case 'click': await loc(target(v), isObj(v) ? v : {}).click({ timeout: stepTimeout, button: v.button }); break;
            case 'dblclick': await loc(target(v)).dblclick({ timeout: stepTimeout }); break;
            case 'fill':
              if (isObj(v) && 'selector' in v && 'value' in v) await loc(v.selector).fill(String(v.value), { timeout: stepTimeout });
              else for (const [sel, val] of Object.entries(v)) await loc(sel).fill(String(val), { timeout: stepTimeout });
              break;
            case 'type': await loc(v.selector).pressSequentially(String(v.text), { delay: v.delay ?? 30, timeout: stepTimeout }); break;
            case 'press': isObj(v) ? await loc(v.selector).press(v.key, { timeout: stepTimeout }) : await page.keyboard.press(v); break;
            case 'select': await loc(v.selector).selectOption(isObj(v.value) ? v.value : String(v.value ?? v.label), { timeout: stepTimeout }); break;
            case 'check': await loc(target(v)).check({ timeout: stepTimeout }); break;
            case 'uncheck': await loc(target(v)).uncheck({ timeout: stepTimeout }); break;
            case 'hover': await loc(target(v)).hover({ timeout: stepTimeout }); break;
            case 'upload': await loc(v.selector).setInputFiles([].concat(v.files).map(outPath), { timeout: stepTimeout }); break;
            case 'scroll':
              if (v === 'bottom' || v === 'top') await page.evaluate(d => window.scrollTo(0, d === 'top' ? 0 : document.body.scrollHeight), v);
              else await loc(target(v)).scrollIntoViewIfNeeded({ timeout: stepTimeout });
              break;
            case 'wait':
              if (typeof v === 'number') await page.waitForTimeout(v);
              else if (typeof v === 'string') await page.locator(v).first().waitFor({ timeout: stepTimeout });
              else if (v.url) await page.waitForURL(u => u.href.includes(v.url), { timeout: stepTimeout });
              else if (v.text) await page.getByText(v.text).first().waitFor({ timeout: stepTimeout });
              else if (v.selector) await page.locator(v.selector).first().waitFor({ state: v.state ?? 'visible', timeout: stepTimeout });
              else if (v.load) await page.waitForLoadState(v.load, { timeout: stepTimeout });
              break;
            case 'extract':
              for (const [name, spec] of Object.entries(v)) { data[name] = vars[name] = await extractOne(spec); }
              break;
            case 'screenshot': {
              const s = typeof v === 'string' ? { path: v } : v ?? {};
              const target2 = s.selector ? page.locator(s.selector).first() : page;
              const buf = await target2.screenshot({ fullPage: s.selector ? undefined : !!s.fullPage, timeout: stepTimeout });
              if (s.path) { const p = outPath(s.path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, buf); files.push(p); }
              if (s.path == null || s.return || opts.images) images.push({ data: buf.toString('base64'), mimeType: 'image/png', label: s.path ?? `step ${stepNo}` });
              break;
            }
            case 'pdf': { const p = outPath(target(v, 'path')); await mkdir(dirname(p), { recursive: true }); await page.pdf({ path: p, format: v.format ?? 'A4', printBackground: true }); files.push(p); break; }
            case 'download': {
              const [dl] = await Promise.all([page.waitForEvent('download', { timeout: stepTimeout }), loc(v.click).click({ timeout: stepTimeout })]);
              const p = outPath(v.saveAs ?? join('downloads', dl.suggestedFilename()));
              await mkdir(dirname(p), { recursive: true });
              await dl.saveAs(p);
              files.push(p);
              if (raw.as) data[raw.as] = vars[raw.as] = p;
              break;
            }
            case 'eval': {
              const code = String(v);
              const result = await page.evaluate(/\breturn\b|;/.test(code) ? `(async () => { ${code} })()` : code);
              if (raw.as) data[raw.as] = vars[raw.as] = result;
              break;
            }
            case 'assert': {
              const conds = isObj(v) ? v : { visible: v };
              if (conds.textContains) {
                const text = await page.locator(conds.selector ?? 'body').first().innerText();
                if (!text.includes(conds.textContains)) throw new Error(`Expected ${conds.selector ?? 'page'} to contain "${conds.textContains}"`);
              } else if (!(await check(conds))) throw new Error(conds.message ?? `Assertion failed: ${JSON.stringify(conds)}`);
              break;
            }
            case 'set': Object.assign(vars, v); break;
            case 'if': {
              const branch = (await check(v)) ? raw.then : raw.else;
              if (branch) await runSteps(branch);
              break;
            }
            case 'repeat': {
              const max = Number(raw.repeat.max ?? 10);
              for (let n = 0; n < max; n++) {
                vars.index = n;
                if (raw.repeat.while && !(await check(render(raw.repeat.while, vars)))) break;
                await runSteps(raw.repeat.steps);
              }
              break;
            }
            case 'log': say(String(v)); break;
          }
          if (action !== 'log' && action !== 'if' && action !== 'repeat') say(`✓ ${describe(raw)} (${Date.now() - t}ms)`);
        } catch (e) {
          if (raw.optional) { say(`- skipped ${describe(raw)}: ${e.message.split('\n')[0]}`); continue; }
          throw e;
        }
      }
    };

    await runSteps(flow.steps);
    if (sessionFile) { await mkdir(dirname(sessionFile), { recursive: true }); await context.storageState({ path: sessionFile }); }
    const output = flow.output ? render(flow.output, vars) : data;
    return { ok: true, output, data, files, images, log, ms: Date.now() - t0 };
  } catch (e) {
    let shot;
    try { if (page) shot = (await page.screenshot({ timeout: 5000 })).toString('base64'); } catch {}
    const msg = e.message.split('\n').filter(l => !/^\s*(at |=+|Call log)/.test(l)).slice(0, 4).join(' ').trim();
    return {
      ok: false, error: msg, failedStep: current ? `#${stepNo} ${describe(current)}` : null, url: page?.url(),
      output: null, data, files, images: shot ? [...images, { data: shot, mimeType: 'image/png', label: 'page at failure' }] : images, log, ms: Date.now() - t0,
    };
  } finally {
    await context?.close().catch(() => {});
    if (ownPool) await pool.close();
  }
}
