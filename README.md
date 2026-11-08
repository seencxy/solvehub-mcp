# solvehub-mcp

MCP server for the [SolveHub](https://www.tiam.codes) CAPTCHA and anti-bot solver API.
Gives Claude, Cursor, VS Code and any other MCP client eight tools to solve a challenge and
get the token, cookie or OCR text back - Turnstile, Interstitial, DataDome, Akamai,
PerimeterX, Imperva, AWS WAF, Alibaba CAPTCHA 2.0, Arkose FunCaptcha and image OCR
through a single REST endpoint.

Zero dependencies, one `npx` command, Node 18 or newer.

## Tools

| Tool | What it does |
| --- | --- |
| `solve_captcha` | Create a task and wait for it, returning the solution (token, cookies or text). |
| `create_task` | Create a task and return its id immediately, for work you finish later. |
| `get_task` | Status of one task, plus its solution once done. |
| `wait_for_task` | Poll an existing task until it is done, failed or cancelled. |
| `cancel_task` | Cancel a queued or running task; the reserved amount is refunded. |
| `list_tasks` | Recent tasks, newest first. |
| `get_balance` | Available and reserved balance in USD. |
| `get_prices` | Live per-task price for every challenge type. |

## Install

Get an API key from the [SolveHub console](https://www.tiam.codes); new accounts get a
$0.10 trial credit after Telegram verification.

### Claude Desktop

Edit `claude_desktop_config.json` and restart the app:

```json
{
  "mcpServers": {
    "solvehub": {
      "command": "npx",
      "args": ["-y", "github:seencxy/solvehub-mcp"],
      "env": { "SOLVEHUB_API_KEY": "sh_live_xxx" }
    }
  }
}
```

### Cursor, VS Code, Cline, Windsurf

Most clients read the same JSON in `mcp.json` (VS Code and Cursor use the `servers` key):

```json
{
  "servers": {
    "solvehub": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:seencxy/solvehub-mcp"],
      "env": { "SOLVEHUB_API_KEY": "sh_live_xxx" }
    }
  }
}
```

### From a clone

```bash
git clone https://github.com/seencxy/solvehub-mcp
cd solvehub-mcp
SOLVEHUB_API_KEY=sh_live_xxx node index.mjs
```

## What it looks like in use

> Solve the Cloudflare Turnstile on https://example.com/login. The site key is 0x4AAAAAAA...
> and I am allowed to test this site.

The model calls `solve_captcha` with `type: turnstile` and the challenge fields, then answers
with the token and its expiry. Anything that needs a proxy (DataDome, Imperva, Akamai,
PerimeterX) takes a `proxy` argument as well, for example `http://user:pass@host:port`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOLVEHUB_API_KEY` | - | Console API key. Required for every tool except `get_prices`. |
| `SOLVEHUB_BASE_URL` | `https://api.tiam.codes` | Override for a self-hosted or staging endpoint. |
| `SOLVEHUB_TIMEOUT_MS` | `30000` | Per-request socket timeout. |

## Billing behaviour you should know

- The price is **frozen when the task is created**, charged **only when it completes**, and
  **refunded** if the task fails or is cancelled. A failed challenge costs nothing.
- The server sends an `Idempotency-Key` on every create, and retries 429/5xx and
  network errors with exponential backoff, so a retry cannot bill the same task twice.
- `get_balance` and `get_prices` are there so an agent can check the cost before
  spending anything.
- `uncertain` is not a failure: the challenge could not be judged yet and can still
  resolve, so `wait_for_task` keeps polling instead of giving up.

## Supported challenge types

| Type | Typical fields |
| --- | --- |
| `turnstile` | `websiteURL`, `websiteKey`, optional `action` / `cdata` |
| `interstitial` | `websiteURL`, proxy; returns the clearance cookie and user agent |
| `datadome` | `websiteURL`, proxy, optional cookies |
| `akamai` | `websiteURL`, proxy; returns `_abck` and `bm_sz` |
| `perimeterx` | `websiteURL`, `appId`, proxy, cookies |
| `imperva` | `websiteURL`, proxy, mode `reese84` or `UT.mvc` |
| `aws_waf` | challenge script URL, optional captcha script, proxy |
| `alibaba` | scene id, identity prefix, verification payload |
| `funcaptcha` | `websiteURL`, `websiteKey`, optional subdomain |
| `image` | `body` with the base64 image; returns the recognised text |

Exact field names per type are in the [API reference](https://www.tiam.codes/docs).

## Development

```bash
npm test
```

The tests run the JSON-RPC dispatcher, the tool schemas and the polling state machine
against a mocked HTTP layer, so they need no API key and no network.

## Related

- [solvehub-python](https://github.com/seencxy/solvehub-python) - Python SDK, also dependency free
- [solvehub-node](https://github.com/seencxy/solvehub-node) - Node SDK
- [API documentation](https://www.tiam.codes/docs)

## Legal

Use it on systems you own or have written permission to test. That is what the API is for,
and the terms say the same thing.

MIT licensed.
