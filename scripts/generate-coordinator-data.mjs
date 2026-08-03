import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseRoute } from "./deterministic-router.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir =
  process.argv[2] || path.join(root, "training", "data", "coordinator");
const evalReportPath =
  process.argv[3] || path.join(root, "runtime", "routing-evals.json");
const suite = JSON.parse(
  fs.readFileSync(path.join(root, "evals", "developer-routing.json"), "utf8"),
);
const profiles = JSON.parse(
  fs.readFileSync(path.join(root, "config", "profiles.json"), "utf8"),
);
const baseConfig = JSON.parse(
  fs.readFileSync(path.join(root, "config", "orchestration.json"), "utf8"),
);

function rankedConfig() {
  const config = structuredClone(baseConfig);
  if (!fs.existsSync(evalReportPath)) return config;
  const report = JSON.parse(fs.readFileSync(evalReportPath, "utf8"));
  for (const [role, rows] of Object.entries(report.roleScores || {})) {
    if (!config.roles[role]) continue;
    config.roles[role] = [
      ...new Set([...rows.map((row) => row.model), ...config.roles[role]]),
    ];
  }
  return config;
}

const config = rankedConfig();
const routable = new Set([
  ...config.coordinator,
  ...config.synthesizer,
  ...Object.values(config.roles).flat(),
]);
const allModels = Object.entries(profiles.profiles)
  .filter(([id, profile]) => profile.supported && routable.has(id))
  .map(([id]) => id);
const prefixes = [
  "",
  "Developer request:\n",
  "Route this engineering task:\n",
  "Choose the smallest effective local team for:\n",
  "A user working in a repository asks:\n",
];
const suffixes = [
  "",
  "\nPrefer a low-latency answer.",
  "\nBe thorough and verify important assumptions.",
  "\nThis affects production, so include validation and rollback.",
  "\nThe repository is unfamiliar and several files may be involved.",
];

function availableSets(index) {
  const rotated = allModels.map(
    (_, offset) => allModels[(index + offset) % allModels.length],
  );
  return [
    allModels,
    rotated.slice(0, Math.max(1, allModels.length - 1)),
    rotated.slice(0, Math.min(2, allModels.length)),
    [rotated[0]],
  ];
}

function capabilities(models) {
  return models.map((id) => {
    const roles = Object.entries(config.roles)
      .filter(([, candidates]) => candidates.includes(id))
      .map(([role]) => role);
    return { id, roles };
  });
}

function label(decision) {
  return {
    version: 1,
    tier: decision.classification.tier,
    primary: {
      role: decision.classification.primaryRole,
      model: decision.model,
    },
    steps: decision.assignments.map((step, index) => ({
      role: step.role,
      model: step.model,
      instruction: step.instruction,
      access: index === 0 ? [] : [index - 1],
    })),
    confidence:
      decision.classification.tier === "simple"
        ? 0.98
        : decision.classification.tier === "moderate"
          ? 0.92
          : 0.88,
  };
}

const system =
  "You are the Chapek Nine coordinator. Select local worker models and a minimal communication topology. Return one JSON object matching the supplied schema; never solve the task, call tools, or add prose.";
const examples = [];
for (let taskIndex = 0; taskIndex < suite.tasks.length; taskIndex += 1) {
  const task = suite.tasks[taskIndex];
  for (let variant = 0; variant < 20; variant += 1) {
    const models = availableSets(taskIndex + variant)[variant % 4];
    const prompt =
      prefixes[variant % prefixes.length] +
      task.prompt +
      suffixes[Math.floor(variant / prefixes.length) % suffixes.length];
    const body = { messages: [{ role: "user", content: prompt }] };
    const decision = chooseRoute(body, config, new Set(models));
    const user = JSON.stringify({
      task: prompt,
      categoryHint: task.category,
      availableWorkers: capabilities(models),
      maxSteps: config.maxAssignments,
    });
    const assistant = JSON.stringify(label(decision));
    const id = crypto
      .createHash("sha256")
      .update(`${task.id}\0${variant}\0${models.join(",")}`)
      .digest("hex");
    examples.push({
      id,
      taskId: task.id,
      category: task.category,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ],
    });
  }
}

// Hold out complete task families, not random prompt variants of tasks that
// also appear in training. This measures generalization to unseen developer
// requests while keeping every routing role represented.
const rolePositions = new Map();
const validationTaskIds = new Set();
for (const task of suite.tasks) {
  const position = rolePositions.get(task.role) || 0;
  if (position % 4 === 0) validationTaskIds.add(task.id);
  rolePositions.set(task.role, position + 1);
}
examples.sort((a, b) => a.id.localeCompare(b.id));
const validation = examples.filter((example) =>
  validationTaskIds.has(example.taskId),
);
const train = examples.filter(
  (example) => !validationTaskIds.has(example.taskId),
);
fs.mkdirSync(outputDir, { recursive: true });
for (const [name, rows] of [
  ["train.jsonl", train],
  ["validation.jsonl", validation],
]) {
  fs.writeFileSync(
    path.join(outputDir, name),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}
fs.copyFileSync(
  path.join(root, "config", "coordinator-schema.json"),
  path.join(outputDir, "schema.json"),
);
fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      suiteVersion: suite.version,
      evalReport: fs.existsSync(evalReportPath)
        ? path.resolve(evalReportPath)
        : null,
      teacher: "deterministic-router",
      trainExamples: train.length,
      validationExamples: validation.length,
      validationTaskIds: [...validationTaskIds].sort(),
      sha256: crypto
        .createHash("sha256")
        .update(train.map((row) => JSON.stringify(row)).join("\n"))
        .digest("hex"),
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    {
      outputDir,
      trainExamples: train.length,
      validationExamples: validation.length,
    },
    null,
    2,
  ),
);
