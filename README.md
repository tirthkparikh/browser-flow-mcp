# browser-flow-mcp

[![npm](https://img.shields.io/npm/v/@tirthlabs/browser-flow-mcp?color=c2410c)](https://www.npmjs.com/package/@tirthlabs/browser-flow-mcp) [![CI](https://github.com/tirthkparikh/browser-flow-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tirthkparikh/browser-flow-mcp/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@tirthlabs/browser-flow-mcp)](LICENSE) · [Live demo](https://tirthparikh.com/tools/browser-flow-mcp/)

**Write a browser task once in YAML. Run it from your terminal or cron, or give it to AI agents as an MCP tool.**

Logging in to a portal, downloading a report, checking a price, filling the same form every week: describe the steps once and they become:

- a command: `npx @tirthlabs/browser-flow-mcp run flows/orders.yml date=2026-10-17`
- a scheduled job that posts results to Slack, n8n or Zapier: `--every 1h --webhook <url>`
- a tool that Claude, Cursor, VS Code or any MCP client can call, with typed inputs, JSON output and screenshots

Unlike a general "AI drives the browser" server, the agent can't wander. It can only run the flows you wrote, with the inputs you allowed. That makes it fast, repeatable and safe to hand to an agent.

## Install

```bash
npm i -D @tirthlabs/browser-flow-mcp playwright
npx playwright install chromium
npx browser-flow-mcp init          # creates flows/ with working examples
npx browser-flow-mcp run flows/hn-top.yml limit=5
```

## A flow

```yaml
name: export_orders
description: Download the orders CSV for a date from the supplier portal.
session: supplier-portal           # keeps cookies, so later runs skip the login
inputs:
  date: { type: string, description: Date as YYYY-MM-DD }
steps:
  - goto: https://portal.example.com/orders
  - if: { visible: "input[type=password]" }
    then:
      - fill:
          "input[name=email]": ${PORTAL_EMAIL}        # from the environment, never in the file
          "input[type=password]": ${PORTAL_PASSWORD}
      - click: button[type=submit]
      - wait: { url: /orders }
  - fill: { "#date": "{{date}}" }
  - click: text=Apply
  - download: { click: "text=Export CSV", saveAs: "downloads/orders-{{date}}.csv" }
    as: file
  - extract:
      total: { selector: ".summary .total", number: true }
      rows:
        selector: table tbody tr
        fields: { id: td:nth-child(1), customer: td:nth-child(2), amount: td:nth-child(3) }
```

Result:

```json
{ "file": "/home/me/flows/downloads/orders-2026-10-17.csv", "total": 1840.5, "rows": [{ "id": "A-1", "customer": "…", "amount": "…" }] }
```

## Use it from AI agents (MCP)

Every `.yml` file in the folder becomes a tool. Its `inputs` become the tool's JSON Schema.

**Claude Desktop / Cursor** (`claude_desktop_config.json` / `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "browser-flows": {
      "command": "npx",
      "args": ["-y", "@tirthlabs/browser-flow-mcp", "serve", "/absolute/path/to/flows"],
      "env": { "PORTAL_EMAIL": "me@company.com", "PORTAL_PASSWORD": "…" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add browser-flows -- npx -y @tirthlabs/browser-flow-mcp serve ./flows
```

- Edit or add flows while the server runs. Clients are told the tool list changed.
- One browser is shared between calls, and each call gets a clean context.
- When a step fails, the agent gets the step, the error, the page URL and a screenshot, so it can explain what went wrong. `run` saves that screenshot as a PNG and puts its path in the result.
- Cancelling a call from the client stops the flow before its next step.
- Session files (`~/.browser-flow/sessions`) hold cookies, so they are created readable only by you.
- `screenshot: {}` with no path returns the image to the agent.
- `readOnly: true` marks a tool as read-only for clients that ask before running anything that changes data.

## Steps

| Step | Example |
| --- | --- |
| `goto` | `goto: https://site.com/{{path}}`. Fails on HTTP 4xx/5xx unless `{ url: …, allowHttpErrors: true }`. Sets `{{status}}` |
| `click` / `dblclick` / `hover` | `click: "text=Sign in"` or `{ selector: ".item", nth: 2 }` |
| `fill` | `fill: { "#email": "{{email}}", "#name": "Tirth" }` |
| `type` | `type: { selector: "#search", text: "{{q}}", delay: 50 }` |
| `press` | `press: Enter` or `{ selector: "#q", key: Enter }` |
| `select` / `check` / `uncheck` | `select: { selector: "#country", value: AE }` |
| `upload` | `upload: { selector: "input[type=file]", files: [invoice.pdf] }` |
| `scroll` | `scroll: bottom` or a selector |
| `wait` | `wait: 1000`, `wait: ".loaded"`, `wait: { url: /done }`, `wait: { text: Saved }` |
| `extract` | `extract: { price: { selector: .price, number: true }, links: { selector: a, attr: href, all: true }, title: { title: true }, url: { url: true } }`. Options: `attr`, `html`, `value`, `number`, `all`, `fields`, `title`, `url` |
| `eval` | `eval: document.title` with `as: title`. `${…}` here is plain JavaScript, not an environment variable |
| `screenshot` / `pdf` | `screenshot: { path: out/page.png, fullPage: true }` |
| `download` | `download: { click: "#export", saveAs: out/file.csv }` |
| `assert` | `assert: { visible: ".dashboard" }`, `{ url: /home }`, `{ textContains: Paid, selector: .status }` |
| `if` | `if: { exists: ".cookie-banner" }` with `then:` / `else:` |
| `repeat` | `repeat: { max: 10, while: { visible: "a.next" }, steps: [...] }` (gives `{{index}}`) |
| `set` / `log` | `set: { page: 1 }` |

Any step can have `optional: true` (skip if it fails), `timeout: 5000` and `as: name`.

`{{name}}` is an input or variable, and `${NAME}` is an environment variable (write `$${NAME}` for a literal `${NAME}`).

Flow options: `browser` (chromium, firefox or webkit), `channel` (`chrome` to use the installed Chrome), `headless`, `viewport`, `userAgent`, `locale`, `timeout`, `session`, `vars`, `output` (shape the result with `{{vars}}`).

## Commands

```
browser-flow-mcp init [dir]               example flows
browser-flow-mcp run <flow.yml> [k=v…]    --headed --out result.json --every 1h --webhook <url>
browser-flow-mcp serve <dir|file>         MCP server over stdio
browser-flow-mcp list <dir|file>          tools and their inputs
browser-flow-mcp check <dir|file>         validate (good for CI)
browser-flow-mcp steps                    step reference
```

## From code

```js
import { loadFlow, runFlow } from '@tirthlabs/browser-flow-mcp';
const res = await runFlow(await loadFlow('flows/orders.yml'), { inputs: { date: '2026-10-17' } });
if (res.ok) console.log(res.output); else console.error(res.failedStep, res.error);
```

Options for `runFlow`: `inputs`, `headless`, `pool` (share one browser between runs with `browserPool()`), `onLog(message)` for live step logs, `images: true` to collect every screenshot as base64, and `onContext(context)` to adjust the Playwright context first (block requests, add cookies, start a trace).

## License

MIT © Tirth Parikh, [tirthparikh.com](https://tirthparikh.com)
