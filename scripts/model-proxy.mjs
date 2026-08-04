import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseRoute, classifyRequest, taskText } from "./deterministic-router.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
import { createScheduler } from "./scheduler.mjs";
import { withRecovery } from "./recovery-controller.mjs";
import { createRuntimeMetrics, resourceDecision, sampleResources, waitForAdmission } from "./runtime-guard.mjs";
import { cache as otelCache, coordinator as otelCoordinator, duration as otelDuration, errors as otelErrors, lifecycle as otelLifecycle, outcomes as otelOutcomes, queueWait as otelQueueWait, recovery as otelRecovery, routes as otelRoutes, setCalibrationHeadroom, setResourceGauges, tps as otelTps, tracer, worker as otelWorker } from "./observability.mjs";
import { loadTaskState, saveTaskState, statePrompt } from "./context-state.mjs";
import { artifactIdentity } from "./domain/model-readiness.mjs";
import { hasCurrentEvaluationEvidence } from "./domain/evaluation-evidence.mjs";
import {
  adaptRequest,
  adaptResponse,
  adaptStreamEvent,
  resolveAdapter,
} from "./model-adapters.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.resolve(process.env.KIMI_MODELS_DIR || path.join(root, "models"));
const baseConfig = JSON.parse(
  fs.readFileSync(path.join(root, "config", "orchestration.json"), "utf8"),
);
const profiles = JSON.parse(
  fs.readFileSync(path.join(root, "config", "profiles.json"), "utf8"),
);
const adapterRegistry = JSON.parse(
  fs.readFileSync(path.join(root, "config", "model-adapters.json"), "utf8"),
);
const coordinatorConfig = JSON.parse(
  fs.readFileSync(path.join(root, "config", "coordinator.json"), "utf8"),
);
const coordinatorSchema = JSON.parse(
  fs.readFileSync(path.join(root, "config", "coordinator-schema.json"), "utf8"),
);
const host = process.env.KIMI_PROXY_HOST || "127.0.0.1";
const port = Number(process.env.KIMI_PROXY_PORT || 8090);
const baseUrl = (process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(
  /\/+$/,
  "",
);
const publicModel = process.env.KIMI_PROXY_MODEL || "chapek-nine";
const coordinatorUrl = process.env.CHAPEK_COORDINATOR_URL?.replace(/\/+$/, "");
// llama.cpp enables authentication when LLAMA_API_KEY is inherited. The
// public proxy stays local-only, but it must authenticate its private calls to
// both the worker router and CPU coordinator.
const llamaApiKey = process.env.KIMI_LLAMA_API_KEY || process.env.LLAMA_API_KEY || "";
const llamaAuthHeaders = llamaApiKey
  ? { Authorization: `Bearer ${llamaApiKey}` }
  : {};
const traceFile = process.env.CHAPEK_TRACE_FILE
  ? path.resolve(process.env.CHAPEK_TRACE_FILE)
  : null;
const kvCacheDir = process.env.KIMI_KV_CACHE_DIR
  ? path.resolve(process.env.KIMI_KV_CACHE_DIR)
  : null;
const taskStateDir = process.env.CHAPEK_TASK_STATE_DIR ||
  (kvCacheDir ? path.join(path.dirname(kvCacheDir), "task-state") : null);
const runtimeState = createRuntimeState(kvCacheDir ? path.join(path.dirname(kvCacheDir), "runtime-state") : null);
const routingEvalsPath =
  process.env.KIMI_ROUTING_EVALS ||
  (kvCacheDir ? path.join(path.dirname(kvCacheDir), "routing-evals.json") : null);
if (kvCacheDir) {
  try {
    const calibrated = JSON.parse(fs.readFileSync(path.join(path.dirname(kvCacheDir), "calibration.json"), "utf8"));
    setCalibrationHeadroom(Object.fromEntries(Object.entries(calibrated.profiles || {}).map(([model, value]) => [model, Number(value.benchmark?.minFreeVramMiB || 0) * 1024 * 1024])));
  } catch {}
}
const coordinatorEvalPath = process.env.CHAPEK_COORDINATOR_EVAL ||
  (kvCacheDir ? path.join(path.dirname(kvCacheDir), "coordinator-eval.json") : null);
const readinessPath = process.env.CHAPEK_READINESS_PATH || null;
const readiness = readinessPath && fs.existsSync(readinessPath) ? JSON.parse(fs.readFileSync(readinessPath, "utf8")) : null;
const publicEligibleModels = readiness ? new Set(readiness.publicEligible || []) : null;
const specialistEligibleModels = readiness
  ? new Set(readiness.specialistEligible || [])
  : null;

function coordinatorPromotionApproved() {
  if (!coordinatorEvalPath || !fs.existsSync(coordinatorEvalPath)) return false;
  try { return JSON.parse(fs.readFileSync(coordinatorEvalPath, "utf8")).promotion?.accepted === true; }
  catch (error) { log(`ignored invalid coordinator evaluation: ${error.message}`); return false; }
}

function configWithEvalRankings(config, reportPath) {
  const output = structuredClone(config);
  if (!reportPath || !fs.existsSync(reportPath)) return output;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const current = Object.fromEntries((report.models || []).map((id) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, id, "manifest.json"), "utf8"));
        return [id, artifactIdentity(manifest)];
      } catch { return [id, null]; }
    }));
    if (!hasCurrentEvaluationEvidence(report, current)) throw new Error("evaluation evidence does not match current model artifacts");
    for (const [role, rankings] of Object.entries(report.roleScores || {})) {
      if (!output.roles[role] || !Array.isArray(rankings)) continue;
      const measured = rankings.map((item) => item.model);
      output.roles[role] = [...new Set([...measured, ...output.roles[role]])];
    }
    log(`loaded routing eval rankings from ${reportPath}`);
  } catch (error) {
    log(`ignored invalid routing eval report: ${error.message}`);
  }
  return output;
}

const config = configWithEvalRankings(baseConfig, routingEvalsPath);
let queueDepth = 0;
const scheduler = createScheduler({ maxDepth: Number(config.maxQueueDepth || 8) });
const metrics = createRuntimeMetrics();

function log(message) {
  process.stderr.write(`[model-proxy] ${new Date().toISOString()} ${message}\n`);
}

async function upstream(route, options = {}, timeoutMs = 1_200_000) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...llamaAuthHeaders,
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${route} failed: ` +
        `${response.status} ${await response.text()}`,
    );
  }
  return response;
}

async function jsonRequest(route, options = {}, timeoutMs) {
  return (await upstream(route, options, timeoutMs)).json();
}

async function catalog(reload = false) {
  const result = await jsonRequest(
    `/models${reload ? "?reload=1" : ""}`,
    {},
    30_000,
  );
  return Array.isArray(result.data) ? result.data : [];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForModel(modelId, predicate, description) {
  const deadline = Date.now() + 1_200_000;
  for (;;) {
    const model = (await catalog()).find((item) => item.id === modelId);
    if (predicate(model?.status?.value)) return model;
    if (["error", "failed"].includes(model?.status?.value)) {
      throw new Error(
        `llama.cpp ${description} failed for '${modelId}': ` +
          JSON.stringify(model.status),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for llama.cpp to ${description} '${modelId}'.`);
    }
    await sleep(250);
  }
}

async function loadOnly(modelId) {
  const lifecycleStarted = performance.now();
  const models = await catalog();
  for (const model of models) {
    if (
      model.id !== modelId &&
      ["loaded", "loading", "sleeping"].includes(model.status?.value)
    ) {
      log(`unload ${model.id}`);
      await jsonRequest("/models/unload", {
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
  // Take the baseline only once any previous model has been released. This
  // avoids attributing the outgoing worker's pages to the incoming worker.
  const resourceBaseline = sampleResources();
  const selected = (await catalog()).find((model) => model.id === modelId);
  if (!selected) throw new Error(`llama.cpp does not know model '${modelId}'.`);
  const loadedHere = selected.status?.value !== "loaded";
  if (loadedHere) {
    log(`load ${modelId}`);
    await jsonRequest("/models/load", {
      method: "POST",
      body: JSON.stringify({ model: modelId }),
    });
    await waitForModel(modelId, (status) => status === "loaded", "load");
  }
  if (loadedHere) runtimeState.allocation(modelId, resourceBaseline, sampleResources());
  else runtimeState.activate(modelId);
  otelLifecycle.record(performance.now() - lifecycleStarted, { model: modelId, operation: "load" });
}

function cacheFilename(modelId, sessionId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${modelId}\0${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `${modelId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${digest}.bin`;
}

function sessionAffinity(req, body) {
  const explicit =
    req.headers["x-session-affinity"] ||
    req.headers["x-client-request-id"] ||
    body.prompt_cache_key;
  if (explicit) return { id: String(explicit), source: "explicit" };

  // Pi's OpenAI-compatible transport does not send its sessionId to local
  // endpoints. Derive a stable, content-addressed conversation identity from
  // the immutable prompt prefix through the first user turn. Identical
  // prefixes are safe to share because llama.cpp validates/reuses tokens, and
  // modelId is added separately by cacheFilename().
  const prefix = [];
  for (const message of body.messages || []) {
    prefix.push(message);
    if (message?.role === "user") break;
  }
  if (!prefix.length) return { id: "", source: "none" };
  const id = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        prefix,
        tools: body.tools || [],
      }),
    )
    .digest("hex");
  return { id, source: "derived-prefix" };
}

async function slotAction(action, modelId, sessionId) {
  if (!kvCacheDir || !sessionId) return false;
  const filename = cacheFilename(modelId, sessionId);
  const fullPath = path.join(kvCacheDir, filename);
  if (action === "restore" && !fs.existsSync(fullPath)) { otelCache.add(1, { model: modelId, action, outcome: "miss" }); return false; }
  try {
    await jsonRequest(`/slots/0?action=${action}`, {
      method: "POST",
      body: JSON.stringify({ filename, model: modelId }),
    }, 120_000);
    log(`${action}d KV slot model=${modelId} session=${sessionId.slice(0, 12)}`);
    otelCache.add(1, { model: modelId, action, outcome: "success" }); return true;
  } catch (error) {
    log(`KV slot ${action} unavailable for ${modelId}: ${error.message}`);
    if (action === "restore") {
      try {
        fs.unlinkSync(fullPath);
      } catch {}
    }
    otelCache.add(1, { model: modelId, action, outcome: "error" }); return false;
  }
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" || part?.type === "input_text")
    .map((part) => part.text || "")
    .join("\n");
}

function orchestrationIds() {
  return new Set([
    ...config.coordinator,
    ...config.synthesizer,
    ...Object.values(config.roles).flat(),
  ]);
}

async function internalChat(model, system, user, maxTokens) {
  const workerStarted = performance.now();
  await loadOnly(model);
  log(`${model} internal generation`);
  const adapter = resolveAdapter(adapterRegistry, model);
  const result = await jsonRequest("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(adaptRequest({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    }, model, adapter, Number(profiles.profiles?.[model]?.context || 4096))),
  });
  const text = messageText(result.choices?.[0]?.message?.content).trim();
  if (!text) throw new Error(`${model} returned no text.`);
  otelWorker.record(performance.now() - workerStarted, { model, role: "specialist" }); return text;
}

function validLearnedDecision(value, available, fallback) {
  if (!value || value.version !== 1) return null;
  if (!["simple", "moderate", "high"].includes(value.tier)) return null;
  if (
    !value.primary ||
    !["general", "analyst", "implementer", "reviewer"].includes(
      value.primary.role,
    ) ||
    !available.has(value.primary.model)
  ) {
    return null;
  }
  if (
    !Number.isFinite(value.confidence) ||
    value.confidence < coordinatorConfig.minimumConfidence ||
    !Array.isArray(value.steps) ||
    value.steps.length > config.maxAssignments
  ) {
    return null;
  }
  const assignments = [];
  for (const step of value.steps) {
    if (
      !step ||
      !config.roles[step.role] ||
      !available.has(step.model) ||
      step.model === value.primary.model ||
      typeof step.instruction !== "string" ||
      step.instruction.length < 8
    ) {
      return null;
    }
    assignments.push({
      role: step.role,
      model: step.model,
      instruction: step.instruction.slice(0, 1000),
      access: Array.isArray(step.access) ? step.access : [],
    });
  }
  return {
    model: value.primary.model,
    maxTokens:
      Number.isInteger(value.primary.maxTokens) &&
      value.primary.maxTokens >= 32 &&
      value.primary.maxTokens <= 4096
        ? value.primary.maxTokens
        : fallback.maxTokens,
    assignments,
    classification: {
      ...fallback.classification,
      primaryRole: value.primary.role,
      tier: value.tier,
    },
    confidence: value.confidence,
    policy: "lora",
  };
}

async function learnedRoute(body, available, fallback) {
  if (!coordinatorUrl || fallback.classification.continuation || !coordinatorPromotionApproved()) return null;
  const workers = [...available].map((id) => ({
    id,
    roles: Object.entries(config.roles)
      .filter(([, candidates]) => candidates.includes(id))
      .map(([role]) => role),
  }));
  try {
    const response = await fetch(`${coordinatorUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...llamaAuthHeaders },
      body: JSON.stringify({
        model: coordinatorConfig.modelId,
        messages: [
          {
            role: "system",
            content:
              "You are the Chapek Nine coordinator. Select local workers and a minimal communication topology. Return only schema-valid JSON; never solve the task or call tools.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: taskText(body.messages),
              availableWorkers: workers,
              maxSteps: config.maxAssignments,
            }),
          },
        ],
        temperature: 0,
        max_tokens: coordinatorConfig.maxTokens,
        response_format: {
          type: "json_schema",
          schema: coordinatorSchema,
        },
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const result = await response.json();
    const text = messageText(result.choices?.[0]?.message?.content);
    const parsed = JSON.parse(text);
    const decision = validLearnedDecision(parsed, available, fallback);
    if (!decision) log(`rejected coordinator plan: ${text.slice(0, 2000)}`);
    return decision;
  } catch (error) {
    log(`learned coordinator fallback: ${error.message}`);
    return null;
  }
}

async function prepareRoute(body) {
  const models = await catalog(true);
  const known = orchestrationIds();
  const knownAvailable = new Set(models.map((model) => model.id).filter((id) => known.has(id)));
  const publicWorkers = new Set(
    [...knownAvailable].filter((id) => !publicEligibleModels || publicEligibleModels.has(id)),
  );
  const specialistWorkers = new Set(
    [...knownAvailable].filter((id) => !specialistEligibleModels || specialistEligibleModels.has(id)),
  );
  if (!publicWorkers.size) {
    throw new Error("No downloaded orchestration model is available.");
  }

  const deterministic = chooseRoute(body, config, { publicWorkers, specialistWorkers });
  const decision =
    (await learnedRoute(body, publicWorkers, deterministic)) || {
      ...deterministic,
      policy: "deterministic",
    };
  const task = taskText(body.messages);
  otelCoordinator.add(1, { policy: decision.policy, tier: decision.classification.tier, role: decision.classification.primaryRole });
  log(
    `deterministic route tier=${decision.classification.tier} ` +
      `role=${decision.classification.primaryRole} model=${decision.model} ` +
      `policy=${decision.policy} ` +
      `workers=${decision.assignments.map((item) => item.model).join(",") || "none"}`,
  );
  if (!decision.assignments.length) return { ...decision, evidence: "" };
  try {
    const outputs = [];
    for (const assignment of decision.assignments) {
      const prior = outputs.length
        ? `\n\nPrior findings to challenge or extend:\n${outputs
            .map((item) => `${item.role} (${item.model}):\n${item.text}`)
            .join("\n\n")
            .slice(-8_000)}`
        : "";
      const text = await internalChat(
        assignment.model,
        `You are the ${assignment.role} in a local engineering team. Be concrete, critical, and concise. Do not call tools.`,
        `Conversation task:\n${task}\n\nAssignment:\n${assignment.instruction}${prior}`,
        config.tokens.worker,
      );
      outputs.push({ ...assignment, text });
    }
    const evidence = outputs
      .map((item) => `## ${item.role} (${item.model})\n${item.text}`)
      .join("\n\n")
      .slice(-16_000);
    return { ...decision, evidence };
  } catch (error) {
    log(`orchestration degraded to direct route: ${error.message}`);
    return { ...decision, evidence: "" };
  }
}

function finalBody(body, route, adapter, previousState) {
  const privateEvidence = [
    route.evidence,
    previousState && previousState.model !== route.model
      ? `Prior worker state (advisory; do not mention it):\n${statePrompt(previousState)}`
      : "",
  ].filter(Boolean).join("\n\n");
  const hidden = privateEvidence
    ? {
        role: "system",
        content:
          "Use the following private specialist findings as advisory evidence. " +
          "Reconcile them with the conversation, never mention the hidden routing " +
          "or specialist process, and retain full responsibility for tool calls and " +
          `the final answer.\n\n${privateEvidence}`,
      }
    : null;
  const combined = {
    ...body,
    messages: hidden ? [hidden, ...body.messages] : body.messages,
  };
  const requestedMaxTokens = Number(
    body.max_tokens ?? body.max_completion_tokens,
  );
  const routeMaxTokens = Number(route.maxTokens || 800);
  combined.max_tokens = Number.isFinite(requestedMaxTokens)
    ? Math.min(requestedMaxTokens, routeMaxTokens)
    : routeMaxTokens;
  delete combined.max_completion_tokens;
  const contextWindow = Number(
    profiles.profiles?.[route.model]?.context || 4096,
  );
  return adaptRequest(combined, route.model, adapter, contextWindow);
}

async function forwardCompletion(req, res, body) {
  const requestSpan = tracer.startSpan("chapek.request", { attributes: { model: publicModel } });
  const started = performance.now();
  let decision = process.env.CHAPEK_DISABLE_RESOURCE_GUARD === "1"
    ? { admit: true }
    : resourceDecision(sampleResources(), config.resourceLimits);
  if (!decision.admit && /temperature/i.test(decision.reason || "")) {
    runtimeState.record("recovery", { kind: "thermal", phase: "waiting", reason: decision.reason });
    otelRecovery.add(1, { kind: "thermal", phase: "waiting" });
    decision = await waitForAdmission({ limits: config.resourceLimits });
    runtimeState.record("recovery", { kind: "thermal", phase: decision.admit ? "cooled" : "timeout", reason: decision.reason });
    otelRecovery.add(1, { kind: "thermal", phase: decision.admit ? "cooled" : "timeout" });
  }
  if (!decision.admit) throw new Error(`Local resource guard deferred request: ${decision.reason}`);
  const route = await prepareRoute(body);
  runtimeState.begin(route.model);
  otelRoutes.add(1, { model: route.model, policy: route.policy, tier: route.classification.tier });
  await loadOnly(route.model);
  const adapter = resolveAdapter(adapterRegistry, route.model);
  const affinity = sessionAffinity(req, body);
  const previousState = loadTaskState(taskStateDir, affinity.id);
  const kvRestored = await slotAction("restore", route.model, affinity.id);
  if (kvRestored) metrics.state.cacheRestores += 1;
  log(
    `final route ${publicModel} -> ${route.model} stream=${Boolean(body.stream)} ` +
      `messages=${body.messages.length} tools=${body.tools?.length || 0} ` +
      `max_tokens=${body.max_tokens ?? "unset"} ` +
      `max_completion_tokens=${body.max_completion_tokens ?? "unset"}`,
  );
  if (traceFile) {
    fs.appendFileSync(
      traceFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        publicModel: body.model,
        routedModel: route.model,
        stream: body.stream,
        max_tokens: body.max_tokens,
        max_completion_tokens: body.max_completion_tokens,
        stop: body.stop,
        messageCount: body.messages.length,
        toolCount: body.tools?.length || 0,
        sessionAffinity: affinity.source,
        sessionHash: affinity.id.slice(0, 12),
        kvRestored,
      })}\n`,
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) abort();
  });
  const requestPayload = JSON.stringify(finalBody(body, route, adapter, previousState));
  const response = await withRecovery(
    async () => upstream("/v1/chat/completions", {
      method: "POST", body: requestPayload, signal: controller.signal,
    }, 1_200_000),
    async (failure) => {
      runtimeState.record("recovery", { model: route.model, kind: failure.kind, action: "unload-reload" });
      otelRecovery.add(1, { model: route.model, kind: failure.kind, phase: "unload-reload" });
      await unloadModel(route.model);
      await loadOnly(route.model);
    },
    (event) => {
      runtimeState.record("recovery", { model: route.model, ...event });
      otelRecovery.add(1, { model: route.model, kind: event.kind, phase: event.phase });
    },
  );

  if (body.stream) {
    const needsCanonicalBuffer = Boolean(body.response_format) || (
      adapter.toolMode === "prompt" && Array.isArray(body.tools) && body.tools.length > 0
    );
    if (needsCanonicalBuffer) {
      try {
        const raw = await response.text();
        let id = `chatcmpl_${crypto.randomBytes(12).toString("hex")}`;
        let created = Math.floor(Date.now() / 1000);
        let content = "";
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const event = JSON.parse(line.slice(6));
            id = event.id || id;
            created = event.created || created;
            content += messageText(event.choices?.[0]?.delta?.content);
          } catch {}
        }
        const canonical = adaptResponse({
          id,
          object: "chat.completion",
          created,
          model: route.model,
          choices: [{ index: 0, message: { role: "assistant", content } }],
        }, publicModel, adapter, body);
        const message = canonical.choices[0].message;
        const delta = message.tool_calls?.length
          ? { role: "assistant", tool_calls: message.tool_calls }
          : { role: "assistant", content: message.content || "" };
        res.writeHead(response.status, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: publicModel, choices: [{ index: 0, delta }] })}\n\ndata: [DONE]\n\n`,
        );
        await slotAction("save", route.model, affinity.id);
        metrics.state.cacheSaves += 1;
        saveTaskState(taskStateDir, affinity.id, route.model, body.messages, message.content);
        metrics.record(route.model, performance.now() - started);
        runtimeState.complete(route.model, { latencyMs: performance.now() - started });
        otelDuration.record(performance.now() - started, { model: route.model, stream: "true" });
        requestSpan.end();
      } finally {
        req.off("aborted", abort);
      }
      return;
    }
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const rawLine of lines) {
          let line = rawLine;
          const normalized = rawLine.endsWith("\r")
            ? rawLine.slice(0, -1)
            : rawLine;
          if (normalized.startsWith("data: {")) {
            try {
              const event = JSON.parse(normalized.slice(6));
              line = `data: ${JSON.stringify(
                adaptStreamEvent(event, publicModel, adapter),
              )}`;
            } catch {}
          }
          if (!res.write(encoder.encode(`${line}\n`))) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
      }
      pending += decoder.decode();
      if (pending && !res.write(encoder.encode(pending))) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
      res.end();
      await slotAction("save", route.model, affinity.id);
      metrics.state.cacheSaves += 1;
      saveTaskState(taskStateDir, affinity.id, route.model, body.messages, "streamed response");
      metrics.record(route.model, performance.now() - started);
      runtimeState.complete(route.model, { latencyMs: performance.now() - started });
      otelDuration.record(performance.now() - started, { model: route.model, stream: "true" }); requestSpan.end();
    } finally {
      reader.releaseLock();
      req.off("aborted", abort);
    }
    return;
  }

  const result = adaptResponse(await response.json(), publicModel, adapter, body);
  if (Number.isFinite(result.timings?.prompt_per_second)) otelTps.record(result.timings.prompt_per_second, { model: route.model, phase: "prompt" });
  if (Number.isFinite(result.timings?.predicted_per_second)) otelTps.record(result.timings.predicted_per_second, { model: route.model, phase: "decode" });
  sendJson(res, response.status, result);
  await slotAction("save", route.model, affinity.id);
  metrics.state.cacheSaves += 1;
  saveTaskState(taskStateDir, affinity.id, route.model, body.messages, result.choices?.[0]?.message?.content);
  metrics.record(route.model, performance.now() - started);
  const sample = sampleResources();
  runtimeState.resource(route.model, Math.round((sample.totalRamGiB - sample.freeRamGiB) * 2 ** 30), Math.round((sample.gpu?.usedMiB || 0) * 1048576));
  runtimeState.complete(route.model, { latencyMs: performance.now() - started, promptTps: result.timings?.prompt_per_second, decodeTps: result.timings?.predicted_per_second });
  otelOutcomes.add(1, { model: route.model, outcome: "success" });
  otelDuration.record(performance.now() - started, { model: route.model, stream: "false" }); requestSpan.end();
}

async function unloadModel(modelId) {
  await jsonRequest("/models/unload", {
    method: "POST",
    body: JSON.stringify({ model: modelId }),
  });
  await waitForModel(
    modelId,
    (status) => !["loaded", "loading", "sleeping", "unloading"].includes(status),
    "unload",
  );
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 50 * 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function enqueue(work, priority = 0) {
  const queuedAt = performance.now();
  queueDepth += 1;
  return scheduler.submit(async () => {
    try { otelQueueWait.record(performance.now() - queuedAt); return await work(); } finally { queueDepth -= 1; }
  }, priority);
}

function routeAffinityPriority(classification) {
  const active = runtimeState.active();
  if (!active) return 0;
  const candidates = config.roles[classification.primaryRole] || config.coordinator || [];
  // The learned coordinator can still override this choice; this is only a
  // queue tie-breaker based on the measured cost of unloading/reloading.
  return candidates.includes(active) ? 1 : 0;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const health = await jsonRequest("/health", {}, 5_000);
      sendJson(res, 200, { status: "ok", upstream: health, resources: sampleResources(), queueDepth });
      return;
    }
    if (req.method === "GET" && url.pathname === "/runtime") {
      sendJson(res, 200, { ...runtimeState.snapshot(), scheduler: scheduler.snapshot() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/dashboard") {
      const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chapek Nine runtime</title><style>body{margin:0;background:#101318;color:#e8edf3;font:14px system-ui;padding:24px}h1{margin:0 0 4px}.muted{color:#9eacbc}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:20px}.card{background:#1a2029;border:1px solid #2b3544;border-radius:10px;padding:14px}.num{font-size:24px;font-weight:650}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px;border-bottom:1px solid #2b3544}code{font-family:ui-monospace,monospace}</style><h1>Chapek Nine</h1><div class="muted">Local model proxy runtime — refreshes every second</div><div id="summary" class="grid"></div><div class="grid"><section class="card"><h2>Models</h2><div id="models"></div></section><section class="card"><h2>Recent events</h2><div id="events"></div></section></div><script>const e=x=>document.getElementById(x),esc=x=>String(x??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const mib=n=>Math.round((n||0)/1048576),rate=n=>Number.isFinite(n)?Number(n).toFixed(1):'—';const render=async()=>{try{const d=await(await fetch('/runtime')).json(),s=d.scheduler||{},m=Object.entries(d.models||{});e('summary').innerHTML=[['Queued',s.pending??0],['Running',s.running?'yes':'no'],['Completed',s.completed??0],['Oldest wait',String(s.oldestWaitMs??0)+' ms']].map(([a,b])=>'<div class="card"><div class="muted">'+a+'</div><div class="num">'+b+'</div></div>').join('');e('models').innerHTML=m.length?'<table><tr><th>Model</th><th>Requests</th><th>Failures</th><th>Latency</th><th>Prompt / decode</th><th>Load delta RAM / VRAM</th><th>Observed host RAM / VRAM</th></tr>'+m.map(([n,v])=>'<tr><td><code>'+esc(n)+'</code></td><td>'+v.requests+'</td><td>'+v.failures+'</td><td>'+esc(v.averageLatencyMs??'—')+' ms</td><td>'+rate(v.promptTps)+' / '+rate(v.decodeTps)+' t/s</td><td>'+mib(v.allocatedRamBytes)+' / '+mib(v.allocatedVramBytes)+' MiB</td><td>'+mib(v.observedRamBytes)+' / '+mib(v.observedVramBytes)+' MiB</td></tr>').join('')+'</table>':'No routed requests yet.';e('events').innerHTML=(d.events||[]).slice(-12).reverse().map(v=>'<p><code>'+esc(v.at)+'</code> '+esc(v.type)+' '+esc(v.model||v.kind||'')+'</p>').join('')||'No events yet.'}catch(err){e('events').textContent='Dashboard unavailable: '+err.message}};render();setInterval(render,1000)</script>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      const resource = sampleResources();
      setResourceGauges(resource, queueDepth);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end("# OpenTelemetry Prometheus exporter is available on CHAPEK_PROMETHEUS_PORT (default 9464).\n");
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [
          {
            id: publicModel,
            object: "model",
            created: 0,
            owned_by: "chapek-nine",
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson(req);
      if (!Array.isArray(body.messages)) {
        sendJson(res, 400, {
          error: { message: "messages must be an array", type: "invalid_request_error" },
        });
        return;
      }
      if (queueDepth >= Number(config.maxQueueDepth || 8)) {
        sendJson(res, 429, { error: { message: "Local model queue is at capacity; retry shortly.", type: "rate_limit_error" } });
        return;
      }
      const classification = classifyRequest(body);
      // Tool-result continuation is a live agent loop and receives the lowest
      // interactive latency.  High-complexity work may wait briefly, which
      // avoids starving edits/tests behind long analytical requests.
      const priority = (classification.continuation ? 3 : classification.tier === "simple" ? 2 : classification.tier === "moderate" ? 1 : 0) + routeAffinityPriority(classification);
      await enqueue(() => forwardCompletion(req, res, body), priority);
      return;
    }
    sendJson(res, 404, {
      error: { message: "Route not found", type: "invalid_request_error" },
    });
  } catch (error) {
    metrics.record(null, 0, error.message);
    runtimeState.fail("unknown", error.message);
    otelErrors.add(1, { type: error.name || "error" });
    otelOutcomes.add(1, { outcome: error.name === "AbortError" ? "cancelled" : "error" });
    log(error.stack || error.message);
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          message: error.message || "Local model proxy failed.",
          type: "api_error",
        },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(port, host, () => {
  log(`transparent front door listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
