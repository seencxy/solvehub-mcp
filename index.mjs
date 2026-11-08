#!/usr/bin/env node
/**
 * SolveHub MCP server - newline-delimited JSON-RPC over stdio.
 *
 * No dependencies: this file only needs Node 18 or newer, because it uses the
 * built-in fetch. Nothing is written to stdout except protocol messages, so it
 * is safe to run from any MCP client.
 *
 *   SOLVEHUB_API_KEY=sh_live_xxx node index.mjs
 */
import { createServer } from "./src/server.mjs";

const apiKey = process.env.SOLVEHUB_API_KEY || "";
const server = createServer({
  apiKey: apiKey,
  baseUrl: process.env.SOLVEHUB_BASE_URL || undefined,
  timeoutMs: Number(process.env.SOLVEHUB_TIMEOUT_MS) || undefined
});

if (!apiKey) {
  process.stderr.write("solvehub-mcp: SOLVEHUB_API_KEY is not set; tool calls will return an error until it is.\n");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  try {
    const response = await server.handle(message);
    if (response) send(response);
  } catch (err) {
    const hasId = message && Object.prototype.hasOwnProperty.call(message, "id");
    send({ jsonrpc: "2.0", id: hasId ? message.id : null, error: { code: -32603, message: String((err && err.message) || err) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    // Not awaited on purpose: a solve_captcha call polls for up to minutes and
    // must not delay a ping or tools/list that arrives in the meantime.
    void handleLine(line);
    index = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
