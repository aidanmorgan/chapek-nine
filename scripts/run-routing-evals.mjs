import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptRequest,
  resolveAdapter,
} from "./model-adapters.mjs";
import { loadDeveloperTaskSuite } from "./developer-task-suite.mjs";
import { classifyRequest } from "./deterministic-router.mjs";
import { assignUtilities, calibratedHeadroom } from "./routing-objective.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(
  /\/+$/,
  "",
);
const outputPath =
  process.argv[2] || path.join(root, "runtime", "routing-evals.json");
const mode = process.argv[3] || "quick";
const suite = loadDeveloperTaskSuite(root);
const profiles = JSON.parse(
  fs.readFileSync(path.join(root, "config", "profiles.json"), "utf8"),
);
const adapterRegistry = JSON.parse(
  fs.readFileSync(path.join(root, "config", "model-adapters.json"), "utf8"),
);
const objective = JSON.parse(
  fs.readFileSync(path.join(root, "config", "routing-objective.json"), "utf8"),
);
const calibrationPath = path.join(root, "runtime", "calibration.json");
const calibration = fs.existsSync(calibrationPath)
  ? JSON.parse(fs.readFileSync(calibrationPath, "utf8"))
  : { profiles: {} };

async function request(route, options = {}, timeout = 1_200_000) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    throw new Error(`${route}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function catalog(reload = false) {
  const value = await request(`/models${reload ? "?reload=1" : ""}`, {}, 30_000);
  return Array.isArray(value.data) ? value.data : [];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForModel(modelId, predicate, description) {
  const deadline = Date.now() + 1_200_000;
  for (;;) {
    const model = (await catalog()).find((item) => item.id === modelId);
    if (predicate(model?.status?.value)) return;
    if (["error", "failed"].includes(model?.status?.value)) {
      throw new Error(
        `llama.cpp ${description} failed for '${modelId}': ` +
          JSON.stringify(model.status),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting to ${description} '${modelId}'.`);
    }
    await sleep(250);
  }
}

async function loadOnly(modelId) {
  const models = await catalog();
  for (const model of models) {
    if (
      model.id !== modelId &&
      ["loaded", "loading", "sleeping"].includes(model.status?.value)
    ) {
      await request("/models/unload", {
        method: "POST",
        body: JSON.stringify({ model: model.id }),
      });
      await waitForModel(
        model.id,
        (status) => !["loaded", "loading", "sleeping", "unloading"].includes(status),
        "unload",
      );
    }
  }
  const current = (await catalog()).find((model) => model.id === modelId);
  if (current?.status?.value !== "loaded") {
    await request("/models/load", {
      method: "POST",
      body: JSON.stringify({ model: modelId }),
    });
    await waitForModel(modelId, (status) => status === "loaded", "load");
  }
}

function textOf(result) {
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text || "").join("");
}

function score(task, text) {
  const lower = text.toLowerCase();
  const all = (task.requiredAll || []).map((term) =>
    lower.includes(term.toLowerCase()),
  );
  const any = (task.requiredAny || []).map((term) =>
    lower.includes(term.toLowerCase()),
  );
  const forbidden = (task.forbidden || []).map((term) =>
    lower.includes(term.toLowerCase()),
  );
  const allScore = all.length ? all.filter(Boolean).length / all.length : 1;
  const anyScore = any.length ? Math.min(1, any.filter(Boolean).length / 2) : 1;
  const penalty = forbidden.filter(Boolean).length * 0.25;
  return Math.max(0, Math.min(1, 0.65 * allScore + 0.35 * anyScore - penalty));
}

const eligibleProfiles = new Set(
  Object.entries(profiles.profiles)
    .filter(([, profile]) => profile.supported)
    .map(([id]) => id),
);
const models = (await catalog(true))
  .map((model) => model.id)
  .filter((id) => eligibleProfiles.has(id));
if (!models.length) throw new Error("No models are present in llama.cpp catalog.");
if (!["quick", "full"].includes(mode)) {
  throw new Error("Eval mode must be 'quick' or 'full'.");
}
const quickRoleCounts = new Map();
const quickTasks = suite.tasks.filter((task) => {
  const count = quickRoleCounts.get(task.role) || 0;
  if (count >= 2) return false;
  quickRoleCounts.set(task.role, count + 1);
  return true;
});
const tasks = mode === "full" ? suite.tasks : quickTasks;
const rows = [];
for (const model of models) {
  await loadOnly(model);
  for (const task of tasks) {
    process.stderr.write(`[eval] ${model} ${task.id}\n`);
    const started = performance.now();
    try {
      const baseRequest = {
        model,
        messages: [
          {
            role: "system",
            content:
              "Answer as a senior software engineer. Be concrete and concise; include code only where useful.",
          },
          { role: "user", content: task.prompt },
        ],
        temperature: 0,
        max_tokens: 500,
        stream: false,
      };
      const adapter = resolveAdapter(adapterRegistry, model);
      const adapted = adaptRequest(
        baseRequest,
        model,
        adapter,
        Number(profiles.profiles?.[model]?.context || 4096),
      );
      const result = await request("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(adapted),
      });
      const text = textOf(result);
      const tier = classifyRequest({ messages: baseRequest.messages }).tier;
      rows.push({
        model,
        taskId: task.id,
        category: task.category,
        role: task.role,
        tier,
        score: score(task, text),
        latencyMs: performance.now() - started,
        promptTps: result.timings?.prompt_per_second,
        generationTps: result.timings?.predicted_per_second,
        memoryHeadroom: calibratedHeadroom(calibration.profiles?.[model]),
        response: text,
      });
    } catch (error) {
      rows.push({
        model,
        taskId: task.id,
        category: task.category,
        role: task.role,
        tier: classifyRequest({ messages: [{ role: "user", content: task.prompt }] }).tier,
        score: 0,
        latencyMs: performance.now() - started,
        error: error.message,
      });
    }
  }
}

assignUtilities(rows, objective);

const rankings = {};
for (const task of tasks) {
  rankings[task.id] = rows
    .filter((row) => row.taskId === task.id)
    .sort(
      (a, b) =>
        b.utility - a.utility ||
        (a.latencyMs || Infinity) - (b.latencyMs || Infinity),
    )
    .map((row) => ({
      model: row.model,
      utility: row.utility,
      score: row.score,
      latencyMs: row.latencyMs,
      generationTps: row.generationTps,
      memoryHeadroom: row.memoryHeadroom,
    }));
}
const roleScores = {};
for (const role of [...new Set(tasks.map((task) => task.role))]) {
  roleScores[role] = models
    .map((model) => {
      const relevant = rows.filter(
        (row) => row.model === model && row.role === role,
      );
      return {
        model,
        utility:
          relevant.reduce((sum, row) => sum + row.utility, 0) /
          Math.max(1, relevant.length),
        quality:
          relevant.reduce((sum, row) => sum + row.score, 0) /
          Math.max(1, relevant.length),
      };
    })
    .sort((a, b) => b.utility - a.utility);
}
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  suiteVersion: suite.version,
  routingObjective: objective,
  mode,
  models,
  taskCount: tasks.length,
  rankings,
  roleScores,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
fs.renameSync(temporary, outputPath);
console.log(JSON.stringify({ outputPath, models, taskCount: tasks.length, roleScores }, null, 2));
