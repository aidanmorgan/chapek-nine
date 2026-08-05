import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptRequest, resolveAdapter } from "./model-adapters.ts";
import { loadDeveloperTaskSuite } from "./developer-task-suite.ts";
import { classifyRequest } from "./domain/routing-policy.ts";
import { assignUtilities, calibratedHeadroom } from "./routing-objective.ts";
import { artifactIdentity } from "./domain/model-readiness.ts";
import { openEvaluationCheckpoint } from "./infrastructure/persistence/evaluation-checkpoint-store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.resolve(process.env.KIMI_MODELS_DIR || path.join(root, "models"));
const baseUrl = (process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const llamaApiKey = process.env.KIMI_LLAMA_API_KEY || process.env.LLAMA_API_KEY || "";
const llamaAuthHeaders = llamaApiKey ? { Authorization: `Bearer ${llamaApiKey}` } : {};
const outputPath = process.argv[2] || path.join(root, "runtime", "routing-evals.json");
const mode = process.argv[3] || "quick";
// A targeted run is the admission path for a worker downloaded after a long
// baseline evaluation: it measures just that worker and merges its evidence.
const requestedModels = process.argv.slice(4).filter(Boolean);
const suite = loadDeveloperTaskSuite(root);
const profiles = JSON.parse(fs.readFileSync(path.join(root, "config", "profiles.json"), "utf8"));
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
    headers: {
      "Content-Type": "application/json",
      ...llamaAuthHeaders,
      ...(options.headers || {}),
    },
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
        `llama.cpp ${description} failed for '${modelId}': ` + JSON.stringify(model.status),
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
    if (model.id !== modelId && ["loaded", "loading", "sleeping"].includes(model.status?.value)) {
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
  const all = (task.requiredAll || []).map((term) => lower.includes(term.toLowerCase()));
  const any = (task.requiredAny || []).map((term) => lower.includes(term.toLowerCase()));
  const forbidden = (task.forbidden || []).map((term) => lower.includes(term.toLowerCase()));
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
const catalogModels = (await catalog(true))
  .map((model) => model.id)
  .filter((id) => eligibleProfiles.has(id));
const models = requestedModels.length ? requestedModels : catalogModels;
const unavailable = requestedModels.filter((id) => !catalogModels.includes(id));
if (unavailable.length) {
  throw new Error(
    `Requested evaluation worker is not a supported local llama.cpp model: ${unavailable.join(", ")}`,
  );
}
if (!models.length) throw new Error("No models are present in llama.cpp catalog.");
const modelArtifacts = Object.fromEntries(
  models.map((id) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, id, "manifest.json"), "utf8"));
    const artifact = artifactIdentity(manifest);
    if (!artifact) throw new Error(`Model ${id} has no valid local manifest.`);
    return [id, artifact];
  }),
);
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
let retainedRows = [];
let retainedModels = [];
let retainedArtifacts = {};
if (requestedModels.length && fs.existsSync(outputPath)) {
  const previous = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (
    previous.suiteVersion !== suite.version ||
    previous.mode !== mode ||
    previous.taskCount !== tasks.length
  ) {
    throw new Error(
      "Existing routing evidence is not compatible with this targeted evaluation; run a complete evaluation for the current suite instead.",
    );
  }
  retainedModels = (previous.models || []).filter((id) => !models.includes(id));
  retainedRows = (previous.rows || []).filter((row) => retainedModels.includes(row.model));
  retainedArtifacts = Object.fromEntries(
    retainedModels
      .filter((id) => previous.modelArtifacts?.[id])
      .map((id) => [id, previous.modelArtifacts[id]]),
  );
  if (retainedModels.length && !retainedRows.length) {
    throw new Error("Existing routing evidence has no usable rows to merge.");
  }
}
const checkpoint = openEvaluationCheckpoint({
  outputPath,
  identity: {
    suiteVersion: suite.version,
    mode,
    models,
    modelArtifacts,
    outputBudgets: objective.outputBudgets,
  },
});
const allRows = () => [...retainedRows, ...checkpoint.rows];
for (const model of models) {
  await loadOnly(model);
  for (const task of tasks) {
    const tier = classifyRequest({
      messages: [{ role: "user", content: task.prompt }],
    }).tier;
    const budgets = objective.outputBudgets?.[tier] || [500];
    for (const maxTokens of budgets) {
      if (checkpoint.has(model, task.id, maxTokens)) continue;
      process.stderr.write(`[eval] ${model} ${task.id} budget=${maxTokens}\n`);
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
          max_tokens: maxTokens,
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
        checkpoint.append({
          model,
          taskId: task.id,
          category: task.category,
          role: task.role,
          tier,
          maxTokens,
          score: score(task, text),
          latencyMs: performance.now() - started,
          promptTps: result.timings?.prompt_per_second,
          generationTps: result.timings?.predicted_per_second,
          memoryHeadroom: calibratedHeadroom(calibration.profiles?.[model]),
          response: text,
        });
      } catch (error) {
        checkpoint.append({
          model,
          taskId: task.id,
          category: task.category,
          role: task.role,
          tier,
          maxTokens,
          score: 0,
          latencyMs: performance.now() - started,
          error: error.message,
        });
      }
    }
  }
}

const rows = allRows();
assignUtilities(rows, objective);
const reportModels = [...retainedModels, ...models];
const reportArtifacts = { ...retainedArtifacts, ...modelArtifacts };

const rankings = {};
for (const task of tasks) {
  rankings[task.id] = rows
    .filter((row) => row.taskId === task.id)
    .sort((a, b) => b.utility - a.utility || (a.latencyMs || Infinity) - (b.latencyMs || Infinity))
    .map((row) => ({
      model: row.model,
      utility: row.utility,
      score: row.score,
      latencyMs: row.latencyMs,
      generationTps: row.generationTps,
      memoryHeadroom: row.memoryHeadroom,
      maxTokens: row.maxTokens,
    }));
}
const roleScores = {};
for (const role of [...new Set(tasks.map((task) => task.role))]) {
  roleScores[role] = reportModels
    .map((model) => {
      const relevant = rows.filter((row) => row.model === model && row.role === role);
      return {
        model,
        utility: relevant.reduce((sum, row) => sum + row.utility, 0) / Math.max(1, relevant.length),
        quality: relevant.reduce((sum, row) => sum + row.score, 0) / Math.max(1, relevant.length),
      };
    })
    .sort((a, b) => b.utility - a.utility);
}
const roleTierPlans = {};
for (const role of [...new Set(tasks.map((task) => task.role))]) {
  roleTierPlans[role] = {};
  for (const tier of ["simple", "moderate", "high"]) {
    const relevant = rows.filter((row) => row.role === role && row.tier === tier);
    if (!relevant.length) continue;
    const grouped = new Map();
    for (const row of relevant) {
      const key = `${row.model}\u0000${row.maxTokens}`;
      const aggregate = grouped.get(key) || {
        model: row.model,
        maxTokens: row.maxTokens,
        utility: 0,
        quality: 0,
        samples: 0,
      };
      aggregate.utility += row.utility;
      aggregate.quality += row.score;
      aggregate.samples += 1;
      grouped.set(key, aggregate);
    }
    roleTierPlans[role][tier] = [...grouped.values()]
      .map((item) => ({
        ...item,
        utility: item.utility / item.samples,
        quality: item.quality / item.samples,
      }))
      .sort((a, b) => b.utility - a.utility || a.maxTokens - b.maxTokens)[0];
  }
}
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  suiteVersion: suite.version,
  routingObjective: objective,
  mode,
  models: reportModels,
  modelArtifacts: reportArtifacts,
  taskCount: tasks.length,
  rankings,
  roleScores,
  roleTierPlans,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
fs.renameSync(temporary, outputPath);
checkpoint.complete();
console.log(
  JSON.stringify(
    { outputPath, models: reportModels, taskCount: tasks.length, roleScores, roleTierPlans },
    null,
    2,
  ),
);
