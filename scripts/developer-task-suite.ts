import fs from "node:fs";
import path from "node:path";

const domains = [
  ["TypeScript service", "HTTP handler, validation layer, and persistence adapter"],
  ["Python asynchronous worker", "async job handler, retry policy, and queue client"],
  ["Java payment service", "transaction boundary, event publisher, and repository"],
  ["C# background service", "hosted worker, cancellation token, and data store"],
  ["Rust network daemon", "async request path, ownership boundaries, and error types"],
  ["C++ ingestion component", "resource-owning parser, thread pool, and file reader"],
  ["PostgreSQL-backed API", "query layer, indexes, and migration scripts"],
  ["React web application", "stateful form, accessibility behavior, and API client"],
  ["mobile client", "offline cache, synchronization queue, and secure storage"],
  ["data pipeline", "scheduled transform, schema contract, and warehouse load"],
  ["Kubernetes workload", "deployment, health checks, autoscaling, and secrets"],
  ["Terraform platform stack", "modules, state, IAM policy, and environment promotion"],
  ["Windows PowerShell automation", "filesystem operations, remoting, and task scheduler"],
  ["identity platform", "session handling, authorization checks, and audit trail"],
  ["payments integration", "idempotency key, ledger write, and provider callback"],
  ["event-driven order system", "outbox, consumer, retry queue, and reconciliation job"],
  ["observability platform", "structured logs, traces, metrics, and alert rules"],
  ["distributed cache", "invalidation protocol, TTL policy, and consistency checks"],
  ["command-line tool", "configuration, dry-run mode, output, and exit codes"],
  ["documentation site", "versioned guides, code snippets, and link validation"],
  ["build and release pipeline", "dependency cache, provenance, artifact, and deployment step"],
  ["machine-learning feature service", "feature lookup, model version, and fallback path"],
  ["test infrastructure", "fixture lifecycle, parallel isolation, and failure diagnostics"],
  ["legacy integration boundary", "protocol adapter, compatibility layer, and rollback path"],
  ["Go API gateway", "middleware chain, upstream pool, and request policy"],
  ["Kotlin Android application", "view model, offline state, and API repository"],
  ["Swift iOS client", "actor-isolated store, background refresh, and keychain"],
  ["PHP commerce site", "checkout controller, cart session, and payment adapter"],
  ["Ruby on Rails application", "Active Record model, background job, and controller"],
  ["Elixir service", "supervisor tree, GenServer state, and message protocol"],
  ["Scala stream processor", "Kafka consumer, offset policy, and transformation stage"],
  ["Node.js gateway", "middleware, downstream client, and circuit breaker"],
  ["GraphQL API", "resolver, dataloader, schema evolution, and authorization"],
  ["gRPC service", "protobuf contract, streaming handler, and retry interceptor"],
  ["WebAssembly module", "host boundary, memory buffer, and capability interface"],
  ["embedded firmware updater", "signed image, bootloader handoff, and recovery slot"],
  ["Linux system daemon", "socket listener, privilege boundary, and unit file"],
  ["network control plane", "configuration propagation, peer state, and convergence loop"],
  ["search indexing service", "document ingest, index writer, and query cache"],
  ["recommendation pipeline", "candidate source, ranker, and experiment assignment"],
  ["analytics dashboard", "query builder, aggregation cache, and visualization state"],
  ["customer support integration", "ticket webhook, CRM adapter, and PII redaction"],
  ["supply-chain service", "inventory reservation, supplier feed, and reconciliation"],
  ["health-record integration", "consent gate, FHIR mapper, and audit ledger"],
  ["media processing worker", "upload receiver, transcoding job, and delivery manifest"],
  ["geospatial service", "tile cache, coordinate transform, and spatial query"],
  ["real-time collaboration service", "operation log, conflict resolver, and presence channel"],
  ["billing platform", "usage meter, invoice generator, and tax calculation boundary"],
];

const patterns = [
  [
    "implementer",
    "feature",
    "Implement a small production feature in the {domain}. Specify the {parts}, input validation, failure response, focused tests, and rollout guard.",
    ["validation", "test"],
    ["error", "rollback", "idempot"],
  ],
  [
    "implementer",
    "debugging",
    "A regression in the {domain} causes intermittent incorrect results. Diagnose likely root causes, give the smallest safe patch around the {parts}, and name regression tests.",
    ["root cause", "test"],
    ["reproduce", "rollback", "invariant"],
  ],
  [
    "implementer",
    "refactoring",
    "Refactor the {domain} around the {parts} while preserving behavior. Show a staged implementation, compatibility boundary, and tests that protect the change.",
    ["compat", "test"],
    ["migration", "rollback", "interface"],
  ],
  [
    "implementer",
    "testing",
    "Create a test strategy and representative tests for the {domain}'s {parts}. Cover normal behavior, edge cases, malformed inputs, and deterministic isolation.",
    ["test", "edge"],
    ["malformed", "fixture", "determin"],
  ],
  [
    "implementer",
    "automation",
    "Implement safe operational automation for the {domain}, including the {parts}. It must support dry-run, structured logs, bounded retries, and verification.",
    ["dry-run", "verification"],
    ["logging", "retry", "rollback"],
  ],
  [
    "analyst",
    "architecture",
    "Compare viable architectures for evolving the {domain}, especially its {parts}. Recommend one with explicit trade-offs, observability, rollout, and rollback.",
    ["trade", "rollback"],
    ["observ", "risk", "migration"],
  ],
  [
    "analyst",
    "performance",
    "The {domain} is missing its latency or throughput target around the {parts}. Give an evidence-first investigation, baseline, profiling plan, and safe optimization sequence.",
    ["baseline", "profil"],
    ["trace", "benchmark", "p99"],
  ],
  [
    "analyst",
    "migration",
    "Plan an online migration for the {domain}'s {parts} while old and new versions overlap. Include compatibility, backfill, verification, and rollback.",
    ["backfill", "rollback"],
    ["compat", "dual", "migration"],
  ],
  [
    "analyst",
    "reliability",
    "Analyze reliability risks in the {domain} around {parts}. Propose failure containment, recovery, observability, and a measurable validation plan.",
    ["failure", "recovery"],
    ["observ", "test", "metric"],
  ],
  [
    "analyst",
    "cost-capacity",
    "Assess capacity and cost choices for the {domain}, focusing on {parts}. State assumptions, measure demand, compare options, and identify scaling risks.",
    ["assumption", "measure"],
    ["cost", "capacity", "risk"],
  ],
  [
    "reviewer",
    "security",
    "Review the {domain} and its {parts} for security defects. Prioritize exploit paths, give concrete remediations, and define tests proving the fixes.",
    ["threat", "test"],
    ["authorization", "input", "secret"],
  ],
  [
    "reviewer",
    "concurrency",
    "Review concurrency and ordering risks in the {domain}'s {parts}. Identify races or duplicate work, propose synchronization or idempotency fixes, and tests.",
    ["race", "test"],
    ["idempot", "lock", "ordering"],
  ],
  [
    "reviewer",
    "correctness",
    "Audit correctness of the {domain} around {parts}. State key invariants, edge cases, likely regressions, and precise tests or assertions.",
    ["invariant", "test"],
    ["edge", "regression", "validation"],
  ],
  [
    "reviewer",
    "resilience",
    "Review failure handling in the {domain}'s {parts}. Find weak recovery paths, timeouts, retry hazards, and the safest corrections with tests.",
    ["failure", "test"],
    ["timeout", "retry", "fallback"],
  ],
  [
    "reviewer",
    "operability",
    "Review the operational readiness of the {domain}, including {parts}. Identify missing diagnostics, unsafe controls, and concrete verification before release.",
    ["diagnostic", "verification"],
    ["logging", "metric", "rollback"],
  ],
];

function generatedTask(domainIndex, patternIndex) {
  const [domain, parts] = domains[domainIndex];
  const [role, category, template, requiredAll, requiredAny] = patterns[patternIndex];
  return {
    id: `family-${String(domainIndex + 1).padStart(2, "0")}-${category}`,
    category: `${category}-${domain.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    role,
    prompt: template.replaceAll("{domain}", domain).replaceAll("{parts}", parts),
    requiredAll,
    requiredAny,
    provenance: { domain, pattern: category, generated: true },
  };
}

export function buildExpandedTaskFamilies() {
  return domains.flatMap((_, domainIndex) =>
    patterns.map((_, patternIndex) => generatedTask(domainIndex, patternIndex)),
  );
}

export function loadDeveloperTaskSuite(root) {
  const materialized = path.join(root, "evals", "developer-routing-full.json");
  if (fs.existsSync(materialized)) {
    return JSON.parse(fs.readFileSync(materialized, "utf8"));
  }
  const core = JSON.parse(
    fs.readFileSync(path.join(root, "evals", "developer-routing.json"), "utf8"),
  );
  const generated = buildExpandedTaskFamilies();
  const tasks = [...core.tasks, ...generated];
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate developer task id '${task.id}'.`);
    ids.add(task.id);
  }
  return {
    version: 2,
    coreTaskCount: core.tasks.length,
    generatedTaskCount: generated.length,
    tasks,
  };
}
