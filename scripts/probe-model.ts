import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptRequest, adaptResponse, resolveAdapter } from "./model-adapters.ts";

const [model, outputPath, manifestPath, contextArgument] = process.argv.slice(2);
const contextLimit = Math.max(512, Number(contextArgument) || 4096);
if (!model || !outputPath) throw new Error("Usage: probe-model.ts <model-id> <output.json>");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterRegistry = JSON.parse(
  fs.readFileSync(path.join(root, "config", "model-adapters.json"), "utf8"),
);
const adapter = resolveAdapter(adapterRegistry, model);
const baseUrl = (process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const headers = { "Content-Type": "application/json" };
if (process.env.LLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.LLAMA_API_KEY}`;
async function response(route, options = {}, timeout = 120_000) {
  return fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeout),
  });
}
async function request(route, options = {}, timeout) {
  const value = await response(route, options, timeout);
  if (!value.ok) throw new Error(`${route}: ${value.status} ${await value.text()}`);
  return value.json();
}
function content(result) {
  return result.choices?.[0]?.message?.content || "";
}
function workerRequest(body) {
  return adaptRequest(body, model, adapter, contextLimit);
}
async function workerCompletion(body, timeout) {
  const result = await request(
    "/v1/chat/completions",
    {
      method: "POST",
      body: JSON.stringify(workerRequest(body)),
    },
    timeout,
  );
  return adaptResponse(result, model, adapter, body);
}
async function check(name, run) {
  const started = performance.now();
  try {
    const value = await run();
    return { name, passed: true, latencyMs: Math.round(performance.now() - started), ...value };
  } catch (error) {
    return {
      name,
      passed: false,
      latencyMs: Math.round(performance.now() - started),
      error: error.message,
    };
  }
}
// llama.cpp returns 400 when the requested worker is already active. Loading
// is an idempotent application operation, so retain that worker and probe it.
const load = await response("/models/load", { method: "POST", body: JSON.stringify({ model }) });
if (!load.ok) {
  const detail = await load.text();
  if (!/already running/i.test(detail)) throw new Error(`/models/load: ${load.status} ${detail}`);
}
const checks = [];
checks.push(
  await check("json_schema", async () => {
    const result = await workerCompletion({
      model,
      messages: [
        { role: "system", content: "Reply only with valid JSON." },
        { role: "user", content: 'Return {"ok":true}.' },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: "json_object" },
    });
    let valid = false;
    try {
      valid = JSON.parse(content(result)).ok === true;
    } catch {}
    if (!valid)
      throw new Error(
        `response was not the requested JSON object: ${String(content(result)).slice(0, 240)}`,
      );
    return {
      promptTps: result.timings?.prompt_per_second || null,
      generationTps: result.timings?.predicted_per_second || null,
    };
  }),
);
checks.push(
  await check("developer_instruction", async () => {
    const result = await workerCompletion({
      model,
      messages: [
        { role: "developer", content: "Reply with exactly the token DEV_OK." },
        { role: "user", content: "What token should you return?" },
      ],
      temperature: 0,
      max_tokens: 512,
    });
    if (!String(content(result)).includes("DEV_OK"))
      throw new Error(
        `developer instruction was not followed: ${String(content(result)).slice(0, 240)}`,
      );
    return {};
  }),
);
checks.push(
  await check("tool_schema", async () => {
    const result = await workerCompletion({
      model,
      messages: [{ role: "user", content: "Use the supplied tool to add 2 and 3." }],
      tools: [
        {
          type: "function",
          function: {
            name: "add",
            description: "Add two integers",
            parameters: {
              type: "object",
              properties: { a: { type: "integer" }, b: { type: "integer" } },
              required: ["a", "b"],
            },
          },
        },
      ],
      tool_choice: "required",
      temperature: 0,
      max_tokens: 256,
    });
    const toolCalls = result.choices?.[0]?.message?.tool_calls || [];
    if (!toolCalls.length)
      throw new Error(`model returned no tool call: ${String(content(result)).slice(0, 240)}`);
    return { toolCalls: toolCalls.length };
  }),
);
checks.push(
  await check("multilingual_code", async () => {
    const result = await request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: "日本語で、Pythonの関数 add(a, b) を一行で書いてください。" },
        ],
        temperature: 0,
        max_tokens: 64,
      }),
    });
    if (!/def\s+add/.test(String(content(result))))
      throw new Error("did not produce the requested Python function");
    return {};
  }),
);
checks.push(
  await check("long_context_recall", async () => {
    const marker = "CHAPEK_LONG_CONTEXT_MARKER_73";
    const filler = "The system is evaluating context retention. ".repeat(
      Math.max(16, Math.min(900, Math.floor(contextLimit / 80))),
    );
    const result = await workerCompletion(
      {
        model,
        messages: [
          {
            role: "user",
            content: `${marker}\n${filler}\nWhat exact marker appeared at the beginning?`,
          },
        ],
        temperature: 0,
        max_tokens: 512,
      },
      240_000,
    );
    if (!String(content(result)).includes(marker))
      throw new Error("long-context marker was not recalled");
    return {};
  }),
);
checks.push(
  await check("streaming", async () => {
    const stream = await response("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(
        workerRequest({
          model,
          messages: [{ role: "user", content: "Reply STREAM_OK." }],
          stream: true,
          temperature: 0,
          max_tokens: 16,
        }),
      ),
    });
    if (!stream.ok || !/text\/event-stream/i.test(stream.headers.get("content-type") || ""))
      throw new Error(`stream endpoint returned ${stream.status}`);
    const text = await stream.text();
    if (!text.includes("data:")) throw new Error("stream had no SSE events");
    return {};
  }),
);
const jsonCheck = checks.find((item) => item.name === "json_schema");
const artifact =
  manifestPath && fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;
const requiredChecks = new Set([
  "json_schema",
  "developer_instruction",
  "tool_schema",
  "streaming",
]);
const capability = Object.fromEntries(checks.map((check) => [check.name, check.passed]));
const probe = {
  version: 4,
  model,
  artifact,
  probedAt: new Date().toISOString(),
  jsonReliable: Boolean(jsonCheck?.passed),
  passed: checks.filter((check) => requiredChecks.has(check.name)).every((check) => check.passed),
  capability,
  checks,
  notes:
    "Core OpenAI/Pi interoperability gates admission. Multilingual code and long-context recall are measured routing capabilities, not reasons to discard an otherwise compatible worker.",
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(probe, null, 2)}\n`);
console.log(JSON.stringify(probe, null, 2));
