import test from "node:test";
import assert from "node:assert/strict";
import { createServer, TASK_TYPES } from "../src/server.mjs";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => (body === undefined ? "" : JSON.stringify(body))
  };
}

function mockFetch(plan) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {}, body: init && init.body });
    if (!plan.length) throw new Error("unexpected request to " + url);
    const step = plan.shift();
    return response(step.status, step.body);
  };
  fn.calls = calls;
  return fn;
}

function server(plan, apiKey) {
  const fetchImpl = mockFetch(plan);
  const instance = createServer({ apiKey: apiKey === undefined ? "sh_live_test" : apiKey, fetchImpl: fetchImpl, sleep: async () => {} });
  return { instance: instance, fetchImpl: fetchImpl };
}

async function call(instance, name, args) {
  return instance.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} } });
}

test("initialize echoes the protocol version and advertises the tools capability", async () => {
  const { instance } = server([]);
  const reply = await instance.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.equal(reply.result.serverInfo.name, "solvehub-mcp");
  assert.ok(reply.result.capabilities.tools);
  assert.equal(await instance.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("tools/list exposes eight tools, each with an object schema and a description", async () => {
  const { instance } = server([]);
  const reply = await instance.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = reply.result.tools;
  assert.equal(tools.length, 8);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 40, tool.name);
  }
  const solve = tools.find((tool) => tool.name === "solve_captcha");
  assert.deepEqual(solve.inputSchema.required, ["type", "task"]);
  assert.deepEqual(solve.inputSchema.properties.type.enum, TASK_TYPES);
});

test("get_balance authenticates with a bearer token and returns the payload", async () => {
  const { instance, fetchImpl } = server([{ status: 200, body: { available: 10.5, reserved: 0.0007 } }]);
  const reply = await call(instance, "get_balance");
  assert.equal(reply.result.isError, undefined);
  assert.match(reply.result.content[0].text, /10\.5/);
  assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer sh_live_test");
  assert.match(fetchImpl.calls[0].headers["User-Agent"], /^solvehub-mcp\//);
});

test("solve_captcha posts type and task, then polls until done", async () => {
  const realNow = Date.now;
  let clock = 1700000000000;
  Date.now = () => clock;
  try {
    const delays = [];
    const fetchImpl = mockFetch([
      { status: 202, body: { id: "task_1", status: "queued", price: 0.0007 } },
      { status: 200, body: { id: "task_1", status: "processing" } },
      { status: 200, body: { id: "task_1", status: "processing" } },
      { status: 200, body: { id: "task_1", status: "done", solution: { value: "0.abc-token" } } }
    ]);
    const instance = createServer({
      apiKey: "sh_live_test",
      fetchImpl: fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
      }
    });
    const reply = await call(instance, "solve_captcha", { type: "turnstile", task: { websiteURL: "https://example.com/login", websiteKey: "0x4AAA" } });
    const data = JSON.parse(reply.result.content[0].text);
    assert.equal(data.solution.value, "0.abc-token");
    assert.equal(JSON.parse(fetchImpl.calls[0].body).type, "turnstile");
    assert.ok(fetchImpl.calls[0].headers["Idempotency-Key"].length >= 16);
    assert.equal(fetchImpl.calls.length, 4);
    assert.match(fetchImpl.calls[1].url, /\/v1\/tasks\/task_1$/);
    assert.deepEqual(delays, [2500, 3750]);
  } finally {
    Date.now = realNow;
  }
});

test("a failed task is reported as a tool error with the API reason", async () => {
  const { instance, fetchImpl } = server([
    { status: 202, body: { id: "task_2", status: "queued" } },
    { status: 200, body: { id: "task_2", status: "failed", error: "proxy unreachable" } }
  ]);
  const reply = await call(instance, "solve_captcha", { type: "datadome", task: { websiteURL: "https://example.com" }, proxy: "http://u:p@127.0.0.1:8080" });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /proxy unreachable/);
  assert.equal(JSON.parse(fetchImpl.calls[0].body).proxy, "http://u:p@127.0.0.1:8080");
});

test("an API error keeps its status code and is not retried", async () => {
  const { instance, fetchImpl } = server([{ status: 401, body: { message: "invalid api key" } }]);
  const reply = await call(instance, "get_balance");
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, "[401] invalid api key");
  assert.equal(fetchImpl.calls.length, 1);
});

test("an unknown task type is rejected before any request is made", async () => {
  const { instance, fetchImpl } = server([]);
  const reply = await call(instance, "solve_captcha", { type: "recaptcha_v9", task: {} });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /unknown task type/);
  const missing = await call(instance, "solve_captcha", { type: "turnstile" });
  assert.match(missing.result.content[0].text, /task must be an object/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("a missing API key produces an actionable error instead of a network call", async () => {
  const { instance, fetchImpl } = server([], "");
  const reply = await call(instance, "get_balance");
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /SOLVEHUB_API_KEY/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("5xx responses are retried", async () => {
  const { instance, fetchImpl } = server([{ status: 503, body: { message: "busy" } }, { status: 200, body: { available: 1 } }]);
  const reply = await call(instance, "get_balance");
  assert.equal(reply.result.isError, undefined);
  assert.equal(fetchImpl.calls.length, 2);
});

test("a task that never settles returns timedOut with its id instead of throwing", async () => {
  const realNow = Date.now;
  let clock = 1700000000000;
  Date.now = () => clock;
  try {
    const plan = [{ status: 202, body: { id: "task_3", status: "queued" } }];
    for (let i = 0; i < 5; i++) plan.push({ status: 200, body: { id: "task_3", status: "uncertain" } });
    const instance = createServer({
      apiKey: "sh_live_test",
      fetchImpl: mockFetch(plan),
      sleep: async (ms) => {
        clock += ms;
      }
    });
    const reply = await call(instance, "solve_captcha", { type: "image", task: { body: "QkFTRTY0" }, timeout_seconds: 5 });
    const data = JSON.parse(reply.result.content[0].text);
    assert.equal(data.timedOut, true);
    assert.equal(data.taskId, "task_3");
    assert.match(data.next, /get_task/);
  } finally {
    Date.now = realNow;
  }
});

test("unknown methods and tools do not crash the server", async () => {
  const { instance } = server([]);
  const method = await instance.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" });
  assert.equal(method.error.code, -32601);
  const tool = await call(instance, "no_such_tool");
  assert.equal(tool.result.isError, true);
  const ping = await instance.handle({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(ping.result, {});
});
