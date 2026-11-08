export const TASK_TYPES = ["turnstile", "interstitial", "datadome", "akamai", "perimeterx", "imperva", "aws_waf", "alibaba", "funcaptcha", "image"];
export const PENDING_STATUSES = ["queued", "processing"];
export const TERMINAL_STATUSES = ["done", "failed", "cancelled"];
export const SERVER_NAME = "solvehub-mcp";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.tiam.codes";
export const DEFAULT_POLL_INTERVAL_MS = 2500;
export const MAX_POLL_INTERVAL_MS = 10000;
export const DEFAULT_TIMEOUT_S = 120;

export class SolveHubError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "SolveHubError";
    this.status = status || null;
    this.payload = payload || {};
  }
}

export class TaskFailedError extends SolveHubError {
  constructor(task) {
    const reason = (task && (task.error || task.status)) || "unknown";
    super("task " + (task && task.id) + " ended as " + JSON.stringify(task && task.status) + ": " + reason);
    this.name = "TaskFailedError";
    this.task = task || {};
  }
}

function newIdempotencyKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return Date.now().toString(16) + Math.random().toString(16).slice(2);
}

export function createClient(options) {
  const opts = options || {};
  const apiKey = opts.apiKey || "";
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs || 30000;
  const maxRetries = opts.maxRetries === undefined ? 2 : opts.maxRetries;

  async function request(method, path, body, extraHeaders, attempt) {
    if (!apiKey) throw new SolveHubError("SOLVEHUB_API_KEY is not set. Create a key in the SolveHub console (https://www.tiam.codes) and pass it in the server environment.");
    const tries = attempt || 0;
    const headers = {
      Authorization: "Bearer " + apiKey,
      Accept: "application/json",
      "User-Agent": SERVER_NAME + "/" + SERVER_VERSION
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(baseUrl + path, {
        method: method,
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (tries < maxRetries) {
        await sleep(500 * Math.pow(2, tries));
        return request(method, path, body, extraHeaders, tries + 1);
      }
      const reason = err && err.name === "AbortError" ? "timed out after " + timeoutMs + "ms" : String((err && err.message) || err);
      throw new SolveHubError("network error calling " + baseUrl + path + ": " + reason);
    }
    if (timer) clearTimeout(timer);
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = { message: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && tries < maxRetries) {
        await sleep(500 * Math.pow(2, tries));
        return request(method, path, body, extraHeaders, tries + 1);
      }
      const message = payload.message || payload.error || ("HTTP " + response.status);
      throw new SolveHubError(message, response.status, payload);
    }
    return payload;
  }

  function createTask(type, task, proxy, idempotencyKey) {
    if (!TASK_TYPES.includes(type)) {
      throw new SolveHubError("unknown task type " + JSON.stringify(type) + "; expected one of " + TASK_TYPES.join(", "));
    }
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new SolveHubError("task must be an object of challenge fields, for example {\"websiteURL\": \"https://example.com/login\", \"websiteKey\": \"0x4AAAAAAA...\"}");
    }
    const body = { type: type, task: task };
    if (proxy) body.proxy = proxy;
    return request("POST", "/v1/tasks", body, { "Idempotency-Key": idempotencyKey || newIdempotencyKey() });
  }

  function getTask(id) {
    if (!id) throw new SolveHubError("task_id is required");
    return request("GET", "/v1/tasks/" + encodeURIComponent(String(id)));
  }

  async function wait(id, timeoutS, intervalMs) {
    const budget = Math.max(1, Number(timeoutS || DEFAULT_TIMEOUT_S)) * 1000;
    const deadline = Date.now() + budget;
    let delay = intervalMs || DEFAULT_POLL_INTERVAL_MS;
    let task = {};
    for (;;) {
      task = await getTask(id);
      const status = task.status;
      if (status === "done") return { task: task, timedOut: false };
      if (status === "failed" || status === "cancelled") throw new TaskFailedError(task);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { task: task, timedOut: true };
      await sleep(Math.min(delay, remaining));
      delay = Math.min(Math.round(delay * 1.5), MAX_POLL_INTERVAL_MS);
    }
  }

  return {
    baseUrl: baseUrl,
    prices: () => request("GET", "/v1/prices"),
    balance: () => request("GET", "/v1/balance"),
    listTasks: (limit) => request("GET", "/v1/tasks?limit=" + encodeURIComponent(String(limit || 20))),
    createTask: createTask,
    getTask: getTask,
    cancelTask: (id) => request("POST", "/v1/tasks/" + encodeURIComponent(String(id)) + "/cancel"),
    wait: wait
  };
}

const TYPE_DESCRIPTION = "Challenge type. turnstile/interstitial (Cloudflare), datadome, akamai, perimeterx (HUMAN), imperva (reese84 or UT.mvc), aws_waf, alibaba (CAPTCHA 2.0), funcaptcha (Arkose), image (OCR of a base64 image).";

export function buildTools() {
  return [
    {
      name: "solve_captcha",
      description: "Create a SolveHub task and wait until it finishes, then return the token, cookie or recognised text. Use this for a site you own or are authorized to test. Typical Turnstile fields: websiteURL and websiteKey; DataDome/Imperva/Akamai need a proxy.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: TASK_TYPES, description: TYPE_DESCRIPTION },
          task: { type: "object", description: "Challenge fields sent as POST /v1/tasks task object, for example {websiteURL, websiteKey, action?, cdata?}.", additionalProperties: true },
          proxy: { type: "string", description: "Optional proxy URL, for example http://user:pass@host:port. Required by most cookie-based challenges (DataDome, Imperva, Akamai, PerimeterX)." },
          timeout_seconds: { type: "integer", description: "How long to wait for the solution. Default 120, maximum 600." },
          idempotency_key: { type: "string", description: "Optional key so a retried create is not billed twice. A random UUID is used when omitted." }
        },
        required: ["type", "task"],
        additionalProperties: false
      }
    },
    {
      name: "create_task",
      description: "Create a SolveHub task and return its id without waiting. Use get_task or wait_for_task afterwards. Billing happens only when the task completes, and the price is frozen at creation.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: TASK_TYPES, description: TYPE_DESCRIPTION },
          task: { type: "object", description: "Challenge fields, same shape as solve_captcha.", additionalProperties: true },
          proxy: { type: "string", description: "Optional proxy URL." },
          idempotency_key: { type: "string", description: "Optional key so a retried create is not billed twice." }
        },
        required: ["type", "task"],
        additionalProperties: false
      }
    },
    {
      name: "get_task",
      description: "Read one task: status (queued, processing, uncertain, done, failed, cancelled) and, once done, its solution. uncertain means the challenge could not be judged yet and can still resolve; poll again.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task id returned by create_task or solve_captcha." } },
        required: ["task_id"],
        additionalProperties: false
      }
    },
    {
      name: "wait_for_task",
      description: "Poll one existing task until it is done, failed or cancelled, or until timeout_seconds pass. Returns the task in either case, with timedOut true when the budget ran out.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task id to poll." },
          timeout_seconds: { type: "integer", description: "Polling budget in seconds. Default 120, maximum 600." }
        },
        required: ["task_id"],
        additionalProperties: false
      }
    },
    {
      name: "cancel_task",
      description: "Cancel a queued or running task. The reserved amount is refunded.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task id to cancel." } },
        required: ["task_id"],
        additionalProperties: false
      }
    },
    {
      name: "list_tasks",
      description: "List the most recent tasks, newest first, with status and type.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", description: "How many tasks to return. Default 20, maximum 100." } },
        additionalProperties: false
      }
    },
    {
      name: "get_balance",
      description: "Current account balance in USD: available and reserved (held by unfinished tasks).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "get_prices",
      description: "Live price catalogue: per-task cost for every supported challenge type. Public, does not need a task.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }
  ];
}

function clampTimeout(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_S;
  return Math.min(Math.max(Math.round(seconds), 1), 600);
}

export function createServer(options) {
  const opts = options || {};
  const client = createClient(opts);
  const tools = buildTools();

  const handlers = {
    solve_captcha: async (args) => {
      const created = await client.createTask(args.type, args.task, args.proxy, args.idempotency_key);
      const id = created && created.id;
      if (!id) throw new SolveHubError("the API did not return a task id; response: " + JSON.stringify(created).slice(0, 300));
      const outcome = await client.wait(id, clampTimeout(args.timeout_seconds));
      if (outcome.timedOut) {
        return { timedOut: true, taskId: id, status: outcome.task.status, next: "call get_task or wait_for_task with task_id " + id };
      }
      return { taskId: id, status: outcome.task.status, solution: outcome.task.solution || null, task: outcome.task };
    },
    create_task: async (args) => {
      const created = await client.createTask(args.type, args.task, args.proxy, args.idempotency_key);
      return { taskId: created.id, status: created.status, price: created.price, task: created };
    },
    get_task: async (args) => client.getTask(args.task_id),
    wait_for_task: async (args) => {
      const outcome = await client.wait(args.task_id, clampTimeout(args.timeout_seconds));
      return { timedOut: outcome.timedOut, taskId: args.task_id, status: outcome.task.status, solution: outcome.task.solution || null, task: outcome.task };
    },
    cancel_task: async (args) => client.cancelTask(args.task_id),
    list_tasks: async (args) => client.listTasks(Math.min(Math.max(Number(args.limit) || 20, 1), 100)),
    get_balance: async () => client.balance(),
    get_prices: async () => client.prices()
  };

  function envelope(id, result) {
    return { jsonrpc: "2.0", id: id, result: result };
  }

  function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id: id, error: { code: code, message: message } };
  }

  async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "invalid request");
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (typeof message.method !== "string") return hasId ? rpcError(message.id, -32600, "missing method") : null;
    if (!hasId) return null;
    const params = message.params || {};
    if (message.method === "initialize") {
      return envelope(message.id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "SolveHub CAPTCHA API. Call solve_captcha with a challenge type and its fields to get a token, cookie or OCR text. Only use it on sites you own or are authorized to test."
      });
    }
    if (message.method === "ping") return envelope(message.id, {});
    if (message.method === "tools/list") return envelope(message.id, { tools: tools });
    if (message.method === "tools/call") {
      const handler = handlers[params.name];
      if (!handler) return envelope(message.id, { content: [{ type: "text", text: "Unknown tool: " + String(params.name) }], isError: true });
      try {
        const data = await handler(params.arguments || {});
        return envelope(message.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        const base = String((err && err.message) || err);
        const text = err && err.status ? "[" + err.status + "] " + base : base;
        return envelope(message.id, { content: [{ type: "text", text: text }], isError: true });
      }
    }
    return rpcError(message.id, -32601, "method not found: " + message.method);
  }

  return { handle: handle, tools: tools, client: client };
}
