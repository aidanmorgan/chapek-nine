# Chapek Nine local orchestration

Research date: 2026-08-03

Sakana Fugu is a hosted multi-agent system, not a downloadable GGUF. Its public
design combines a learned coordinator with heterogeneous workers. The
Conductor work trains a Qwen2.5-family coordinator to select workers, write
focused subtasks, and specify which previous outputs each step may see.

Chapek Nine preserves the most useful boundary—a single model API—while
adapting execution to the CPU, RAM, GPU, and VRAM discovered during `init`:

```text
Pi -> chapek-nine front door (:8090)
       -> CPU-only Qwen2.5 0.5B + LoRA coordinator
            \-> deterministic teacher/fallback
       -> sequential private specialists (optional)
       -> final worker with canonical Pi messages, tools, and evidence
            -> llama.cpp model router (:8080)
```

Pi can neither enumerate nor invoke the workers. `/v1/models` returns only
`chapek-nine`, and all response/chunk model identifiers are rewritten to that
public name.

## Routing policy

`scripts\deterministic-router.mjs` is the auditable teacher and permanent
safety fallback. It identifies implementation, analysis, review, and general
work, then assigns simple, moderate, or high complexity:

- simple turns use one worker;
- a turn following a tool result stays direct, avoiding committee recursion
  inside Pi's agent loop;
- moderate turns may call one complementary specialist;
- high-complexity turns may call at most the configured assignment limit;
- only artifact-verified profiles already present in llama.cpp's local catalog
  can be admitted; public workers require the full Pi protocol contract, while
  internal specialists require their smaller recorded specialist contract;
- routing never downloads a model or calls a remote inference API.

Default role preferences are stored in `config\orchestration.json`. Measured
role rankings from `routing-evals.json` are placed before the static fallback
order. The proxy serializes requests and unloads the previous worker before
loading the next, allowing every role to reuse the same RAM/VRAM.

Private specialist output is bounded and inserted into the final worker's
system context. The final turn retains the original Pi conversation,
definitions, tool choice, streaming flag, and sampling controls.

## Coordinator LoRA

The coordinator base is the official Qwen2.5 0.5B Instruct GGUF. It is small
enough to remain CPU-resident next to a large worker and is served by a
separate llama.cpp process with GPU and KV offload disabled. Its only output is
schema-constrained JSON containing:

- complexity tier;
- primary worker role/model;
- a bounded sequence of specialist steps;
- per-step instructions and evidence access;
- confidence.

`scripts\generate-coordinator-data.mjs` creates train/validation JSONL from:

1. the deterministic policy;
2. varying worker-availability sets;
3. common developer-task prompts and difficulty variants; and
4. measured task/role rankings from the eval report when available.

`training\train_coordinator.py` performs all-linear BF16 LoRA by default and
can use QLoRA when requested. `train-coordinator` creates an isolated venv,
trains the adapter, and converts it with llama.cpp's
`convert_lora_to_gguf.py`.

Every learned plan is validated against `config\coordinator-schema.json`,
available model IDs, maximum step count, and minimum confidence. Timeout,
invalid JSON/schema, unavailable workers, or low confidence immediately falls
back to the deterministic route. This means the learned policy can improve
selection without becoming a correctness dependency.

## Developer routing evals

`evals\developer-routing.json` covers feature implementation, debugging,
review, security, architecture, performance, testing, frontend, APIs,
databases, DevOps, PowerShell, C++, Rust, Python, type systems, SQL,
observability, documentation, dependency upgrades, Git, incidents,
algorithms, and agentic tool use.

```powershell
.\harness.ps1 evals quick
.\harness.ps1 evals full
```

The runner tests every downloaded worker through the llama.cpp router and
records required/forbidden criteria, latency, and prompt/decode throughput.
Long runs checkpoint each completed `(model, task, output budget)` record with
the exact suite and artifact identities, and resume only when that identity
still matches. The result influences both runtime role order and the next
generated coordinator dataset.

## Model-family request adapters

`config\model-adapters.json` is data-driven and supports inheritance.
`scripts\model-adapters.mjs` handles:

- developer-to-system role conversion and adjacent system merging;
- text-part normalization;
- tool name and JSON Schema cleanup;
- removal of unsupported request fields;
- `max_completion_tokens`/`max_tokens` translation and context clamping;
- tool-call IDs and JSON argument strings;
- explicit text-protocol tool-call translation for workers without native
  OpenAI tool calls; and
- public model identity in responses and SSE chunks.

Adding another llama.cpp-compatible worker generally requires one profile,
one routing-order entry, and an adapter entry only when its API behavior
differs.

## Context and KV continuity

KV state is valid only for the exact model that produced it, so Chapek Nine
does not attempt unsafe cross-model tensor conversion. It forwards the full
canonical transcript to every selected worker and saves llama.cpp slot zero to
a file keyed by `(model ID, conversation affinity)`.

Pi's local OpenAI transport currently omits its session ID. The proxy therefore
derives a stable content-addressed affinity from the immutable prompt prefix
through the first user turn plus its tool definitions; explicit affinity
headers or `prompt_cache_key` take precedence. Identical prefixes are safe to
share because llama.cpp validates token reuse. A restore error removes the
stale cache and performs a normal prefill.

Consequently:

- the first visit to a worker costs one prompt prefill;
- continued turns reuse its in-memory/persistent prefix;
- switching to another worker creates a separate cache; and
- switching back restores the original worker's cache.

## Verification

`tests\proxy-smoke.mjs` covers single-model exposure, deterministic and
specialist routing, tool preservation, family adaptation, SSE identity, and
derived-prefix slot restoration. `smoke` adds live llama.cpp and Pi inference.

Primary references:

- https://github.com/SakanaAI/fugu
- https://arxiv.org/abs/2606.21228
- https://arxiv.org/abs/2512.04388
- https://arxiv.org/abs/2512.04695
- https://huggingface.co/docs/peft/main/developer_guides/quantization
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
