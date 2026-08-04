import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptRequest, resolveAdapter } from "../scripts/model-adapters.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamPort = 18091;
const proxyPort = 18090;
const requests = [];
const slotActions = [];
const upstreamToken = "proxy-smoke-token";
const kvCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-nine-kv-test-"));
const adapterRegistry = JSON.parse(
  fs.readFileSync(path.join(root, "config", "model-adapters.json"), "utf8"),
);
let loaded = "gemma4";
const modelIds = ["kimi-linear", "qwen-coder", "gemma4", "granite"];

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const mock = http.createServer(async (req, res) => {
  // Exercise the common local setup where llama.cpp inherited LLAMA_API_KEY.
  // The public front door must keep that credential private while using it on
  // every upstream request (models, slots, and completions).
  if (req.headers.authorization !== `Bearer ${upstreamToken}`) {
    json(res, 401, { error: "missing or invalid upstream token" });
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${upstreamPort}`);
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { status: "ok" });
  } else if (req.method === "GET" && url.pathname === "/models") {
    json(res, 200, {
      data: modelIds.map((id) => ({
        id,
        status: { value: id === loaded ? "loaded" : "unloaded" },
      })),
    });
  } else if (req.method === "POST" && url.pathname === "/models/load") {
    loaded = (await body(req)).model;
    json(res, 200, { success: true });
  } else if (req.method === "POST" && url.pathname === "/models/unload") {
    const target = (await body(req)).model;
    if (loaded === target) loaded = null;
    json(res, 200, { success: true });
  } else if (req.method === "POST" && url.pathname === "/slots/0") {
    const payload = await body(req);
    const action = url.searchParams.get("action");
    const slotPath = path.join(kvCacheDir, payload.filename);
    slotActions.push({ action, ...payload });
    if (action === "save") {
      fs.writeFileSync(slotPath, `mock slot for ${payload.model}`);
      json(res, 200, { success: true });
    } else if (action === "restore" && fs.existsSync(slotPath)) {
      json(res, 200, { success: true });
    } else {
      json(res, 404, { error: "slot not found" });
    }
  } else if (
    req.method === "POST" &&
    url.pathname === "/v1/chat/completions"
  ) {
    const payload = await body(req);
    requests.push(payload);
    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          model: payload.model,
          choices: [{ index: 0, delta: { content: "STREAM OK" } }],
        })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      json(res, 200, {
        id: "mock",
        object: "chat.completion",
        model: payload.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: payload.messages[0]?.content?.includes("private specialist")
                ? "FINAL WITH EVIDENCE"
                : "INTERNAL OR DIRECT",
            },
          },
        ],
      });
    }
  } else {
    json(res, 404, { error: "not found" });
  }
});

await new Promise((resolve) => mock.listen(upstreamPort, "127.0.0.1", resolve));
const child = spawn(process.execPath, ["scripts/model-proxy.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    LLAMA_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    KIMI_PROXY_PORT: String(proxyPort),
    KIMI_KV_CACHE_DIR: kvCacheDir,
    KIMI_LLAMA_API_KEY: upstreamToken,
    CHAPEK_DISABLE_RESOURCE_GUARD: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let errors = "";
child.stderr.on("data", (chunk) => {
  errors += chunk;
});

async function waitForProxy() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Proxy did not start:\n${errors}`);
}

try {
  const glmRequest = adaptRequest(
    {
      model: "chapek-nine",
      messages: [
        { role: "developer", content: "Use repository conventions." },
        { role: "user", content: "Inspect this failing test." },
      ],
      max_completion_tokens: 400,
      tools: [{ type: "function", function: { name: "read/file" } }],
    },
    "glm-flash",
    resolveAdapter(adapterRegistry, "glm-flash"),
    16_384,
  );
  assert.equal(glmRequest.model, "glm-flash");
  assert.equal(glmRequest.messages[0].role, "system");
  assert.match(glmRequest.messages[0].content, /repository conventions/i);
  assert.equal(glmRequest.chat_template_kwargs.enable_thinking, false);
  assert.equal(glmRequest.repeat_penalty, 1);
  assert.equal(glmRequest.min_p, 0.01);
  assert.equal(glmRequest.max_tokens, 400);
  assert.equal(glmRequest.tools[0].function.name, "read_file");

  await waitForProxy();
  const models = await (
    await fetch(`http://127.0.0.1:${proxyPort}/v1/models`)
  ).json();
  assert.deepEqual(models.data.map((item) => item.id), ["chapek-nine"]);
  const metrics = await (await fetch(`http://127.0.0.1:${proxyPort}/metrics`)).text();
  assert.match(metrics, /OpenTelemetry Prometheus exporter/);

  const malformed = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chapek-nine" }),
  });
  assert.equal(malformed.status, 400);

  const tools = [
    {
      type: "function",
      function: { name: "read_file", parameters: { type: "object" } },
    },
  ];
  const complex = await fetch(
    `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chapek-nine",
        messages: [
          { role: "developer", content: "Use tools carefully." },
          {
            role: "user",
            content:
              "Implement a TypeScript API across the repository and deeply review its architecture and failure modes.",
          },
        ],
        tools: [
          {
            ...tools[0],
            function: {
              ...tools[0].function,
              parameters: {
                ...tools[0].function.parameters,
                $schema: "https://json-schema.org/draft/2020-12/schema",
              },
            },
          },
        ],
        tool_choice: "auto",
        max_completion_tokens: 777,
        stream: false,
      }),
    },
  );
  assert.equal(complex.status, 200);
  const complexResult = await complex.json();
  assert.equal(complexResult.model, "chapek-nine");
  assert.equal(complexResult.choices[0].message.content, "FINAL WITH EVIDENCE");
  const finalRequest = requests.at(-1);
  assert.equal(finalRequest.tools[0].function.parameters.$schema, undefined);
  assert.equal(finalRequest.tool_choice, "auto");
  assert.equal(finalRequest.max_completion_tokens, undefined);
  assert.equal(finalRequest.max_tokens, 777);
  assert.equal(finalRequest.messages[0].role, "system");
  assert.match(finalRequest.messages[0].content, /Use tools carefully/);
  assert.equal(finalRequest.model, "qwen-coder");

  const beforeSimple = requests.length;
  const simple = await fetch(
    `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chapek-nine",
        messages: [{ role: "user", content: "Reply with exactly: STREAM OK" }],
        stream: true,
      }),
    },
  );
  assert.equal(simple.status, 200);
  const streamText = await simple.text();
  assert.match(streamText, /STREAM OK/);
  assert.match(streamText, /"model":"chapek-nine"/);
  assert.doesNotMatch(streamText, /"model":"gemma4"/);
  assert.equal(requests.length, beforeSimple + 1);
  assert.equal(requests.at(-1).model, "gemma4");
  assert.equal(
    requests.at(-1).chat_template_kwargs.enable_thinking,
    false,
  );

  const repeated = await fetch(
    `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chapek-nine",
        messages: [{ role: "user", content: "Reply with exactly: STREAM OK" }],
        stream: true,
      }),
    },
  );
  await repeated.text();
  assert.ok(
    slotActions.some(
      (item) => item.action === "restore" && item.model === "gemma4",
    ),
    "the second identical Pi-style turn should restore its derived-prefix slot",
  );
  const finalMetrics = await (await fetch(`http://127.0.0.1:${proxyPort}/metrics`)).text();
  assert.match(finalMetrics, /OpenTelemetry Prometheus exporter/);
  console.log("Proxy smoke test passed.");
} finally {
  child.kill();
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(kvCacheDir, { recursive: true, force: true });
}
