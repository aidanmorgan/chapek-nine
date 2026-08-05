# Chapek Nine

Chapek Nine is a native Windows and macOS engineering harness for
[Pi](https://pi.dev) backed by [llama.cpp](https://github.com/ggml-org/llama.cpp)
and CUDA. Pi sees one OpenAI-compatible model named `chapek-nine`; a private
front door routes work across locally installed Kimi, Qwen, Gemma, and Granite
GGUFs, adapts requests for each family, and switches one worker at a time so
the workers can share a single GPU.

## Quick start

```powershell
cd C:\dev\projects\kimi
.\harness.ps1 init
.\harness.ps1 pi
```

On Apple Silicon macOS, use the matching native entry point. It installs the
Homebrew Metal build of llama.cpp and retains the same model manifests,
calibration search, proxy, adapters, and routing policy; only hardware and
process lifecycle are platform adapters.

```bash
cd /path/to/chapek-nine
./harness.sh init
./harness.sh pi
```

`init` is the complete setup path: it installs local dependencies, downloads
supported workers, fully calibrates and probes them, verifies API conformance,
runs routing evals, records an experiment, ensures a coordinator adapter
exists, evaluates its hold-out gate, and leaves the local front door running.

The default worker download is approximately 18 GB. Downloads are segmented,
resumable, checksum-verified against Hugging Face LFS metadata, and retry
transient timeouts or early CDN EOFs without a cumulative time limit. A
per-profile lock prevents concurrent writers, and a valid older cache file is
adopted by NTFS hard link when possible.

To ensure every practical configured worker is present, use the sequential,
resumable verified download command. Capability-gated profiles such as Kimi K3
are reported as skipped rather than treated as failures.

```powershell
.\harness.ps1 download-all
```

`verify-all` performs an actual CUDA generation test for every locally
downloaded practical worker and writes one immutable-result report per worker
under `runtime\verification`. A zero process exit code alone is not accepted:
the worker must emit the required verification token.

`readiness` writes and prints the admission report used by the front door. It
separates public Pi-worker admission from internal-specialist admission and
shows exactly why an installed worker is not admitted to either role.
Verification and probing refresh this report automatically; a successful probe
also restarts only the front door when its admission set changes.
All lifecycle evidence is bound to the downloaded manifest (repository, quant,
model identity, and file hashes). Replacing a model or quantization deliberately
invalidates old verification, calibration, and probe reports.

Models and generated runtime data can live on another disk:

```powershell
$env:KIMI_MODELS_DIR = "D:\chapek-models"
$env:KIMI_RUNTIME_DIR = "D:\chapek-runtime"
```

## One public model, private orchestration

`GET /v1/models` on the front door exposes only `chapek-nine`. There is no
public orchestration command or Pi extension. For each normal Pi turn the
front door:

1. classifies the developer task with the CPU-resident, LoRA-tuned 0.5B
   coordinator;
2. validates its structured routing plan against available workers and safety
   limits, falling back to the deterministic teacher policy on any failure;
3. optionally runs complementary specialists sequentially;
4. sends the original Pi messages, tools, and private specialist evidence to
   the final worker; and
5. rewrites streaming and non-streaming responses back to the public
   `chapek-nine` identity.

Tool-result continuation turns stay with the active worker instead of invoking
a new committee. Per-family adapters merge unsupported developer/system roles,
normalize multimodal text parts, sanitize tool JSON Schema, translate token
fields, and normalize tool calls. Add or override adapters in
`config\model-adapters.json`; routing order and budgets live in
`config\orchestration.json`.

The coordinator training set is generated from the deterministic policy plus
the measured developer-task routing evals. Its versioned corpus combines 24
hand-written tasks with 720 cross-domain engineering task families. It records
a 95% / ±10% aggregate-role holdout target (97 independent families per role)
and holds out entire task families to prevent prompt-variant leakage. It
learns only to produce a small
worker plan; it never executes tools or solves the task itself. See
[the orchestration design](docs/LOCAL-ORCHESTRATION.md).

Routing evals score each model per task using tier-specific quality, decode
tokens/second, latency, and calibrated memory-headroom weights. Simple turns
favor responsiveness; complex engineering work favors quality. Models below
the memory-headroom floor are not selected. Tune weights in
`config\routing-objective.json`.

## Local operations and model onboarding

The proxy admits work only while its RAM, VRAM, and GPU-temperature safety
limits are met. It exposes local-only `GET /metrics` and augments `/health`
with current resource data, route counts, failures, queue depth, and slot-cache
activity. A bounded task-state brief is retained per conversation prefix; on a
model switch it supplements the canonical transcript while each worker keeps
its own compatible llama.cpp slot cache.

After each model download, run:

```powershell
.\harness.ps1 calibrate glm-flash full
.\harness.ps1 probe glm-flash
.\harness.ps1 evals full
.\harness.ps1 train-coordinator
.\harness.ps1 evaluate-coordinator
```

If a model downloads while a full suite is running, do not restart the
baseline. After it completes, `await-evals` verifies, calibrates, probes, and
merges a full targeted evaluation with `.\harness.ps1 evals <profile> full`.
The resulting report retains the measured evidence for every worker before the
coordinator is trained.

To calibrate every downloaded, supported worker serially, use
`.\harness.ps1 calibrate-all full`. Each installed runtime-supported model
is measured; unsafe or unproductive candidates are rejected by calibration.

For a fresh machine, `init` downloads every practical supported worker,
calibrates and probes them serially, and starts the normal worker again:

```powershell
.\harness.ps1 init
```

K3 remains excluded until upstream llama.cpp can load it; all other supported
profiles are assessed by the local calibration run.

The practical worker set includes Kimi Linear Q2, DeepSeek R1 Distill Qwen 14B,
DeepSeek Coder V2 Lite, and the Code Llama 13B Instruct candidate at Q4_K_M.
Code Llama is not selected by static routing: it must earn a role through
measured local evaluation. The DeepSeek variants are approximately
9–10 GB GGUFs that are calibrated before routing can select them.

Calibration appends a history entry and flags material decode-throughput
regressions. `probe` writes a capability report under `runtime\capabilities`.
`evaluate-coordinator` uses held-out families and retains deterministic routing
as the safe fallback when the QLoRA policy misses its promotion thresholds.

## CPU/GPU calibration

```powershell
.\harness.ps1 calibrate kimi-linear quick
.\harness.ps1 calibrate kimi-linear full
```

Calibration uses bounded measurement-driven search over MoE expert splits (or
dense GPU-fit targets), CPU threads, batch and micro-batch sizes, KV-cache
quantization, Flash Attention, and—in full mode—larger safe context targets,
using `llama-bench` while sampling RAM and VRAM. It selects
the highest measured prompt/decode throughput that retains model-relative
headroom. Memory already occupied by Codex and the desktop is treated as host
overhead rather than charged to the model; a small OS/display reserve and a
prolonged-collapse guard remain.

The generated `calibration.json` is machine-specific and is applied
automatically. Dense models use llama.cpp automatic layer fitting instead. See
[the hybrid-offload notes](docs/HYBRID-OFFLOAD.md).

Native Windows CUDA is verified with `llama-server --list-devices`; neither
WSL nor a system-wide CUDA toolkit is required. Apple Silicon uses llama.cpp's
native Metal backend through Homebrew. Its GPU uses unified memory, so the
calibrator treats RAM as one shared pool instead of double-counting it as both
RAM and VRAM. `./harness.sh doctor` records the CPU, unified accelerator, and
memory discovered through macOS system APIs. WSL remains an optional fallback
for unsupported experimental runtimes.

## Context across model switches

KV tensors cannot be transferred between different weights, architectures, or
tokenizers. Chapek Nine therefore always preserves the canonical Pi transcript
and maintains a separate persistent llama.cpp slot cache for each
`(worker model, conversation prefix)` pair. A switch to a new worker performs
one prompt prefill; switching back restores that worker's own cache. An
incompatible or stale slot is deleted and rebuilt safely.

Pi's OpenAI transport reserves 4,096 context tokens internally. The generated
Pi catalog compensates for that transport allowance while retaining the real
llama.cpp input-plus-output limit; this is necessary for small local contexts
and does not enlarge the physical slot.

## Models

The practical default is Kimi Linear 48B-A3B Instruct Q2. The official Kimi K3
checkpoint remains capability-gated: it has 2.8T total / 104B active
parameters, needs terabyte-class host capacity, and does not yet have a working
upstream llama.cpp graph/converter. The harness will not silently substitute a
remote API.

Download specialists independently:

```powershell
.\harness.ps1 download glm-flash
.\harness.ps1 download gemma4
.\harness.ps1 download qwen-coder
.\harness.ps1 download granite
```

`glm-flash` is GLM-4.7-Flash 30B-A3B at UD-Q4_K_XL (17.52 GB), the
strongest current GLM variant that fits this machine. The newer GLM-5.2 and
full GLM-4.7 checkpoints are 744B-A40B and 355B-A32B respectively, so they are
outside the host's RAM capacity. The GLM adapter disables unbounded thinking
for reliable Pi-visible answers, applies the model-card repeat/min-p settings,
and retains native tool calling.

## Commands

```text
setup                         Install Pi and native CUDA llama.cpp
doctor                        Show hardware, CUDA, runtime, and model status
profiles                      List worker profiles
download [profile]            Resume, download, and verify a worker
download-all                  Resume, download, and verify every configured worker
verify [profile]              Prove direct CUDA inference
verify-all                    Prove direct CUDA inference for every configured worker
calibrate [profile] [mode]    Tune CPU/GPU placement (quick or full)
calibrate-all [mode]          Tune every downloaded safe worker serially
init                          Install, download, tune, probe, evaluate, train where supported, and smoke-test
readiness                     Refresh and display worker admission evidence
probe [profile]               Create a local worker capability report
evals [profile] [quick|full]  Rank every worker, or merge a newly admitted worker
train-coordinator             Generate data and train/convert coordinator LoRA
evaluate-coordinator          Gate learned routing on held-out data
await-evals                   Continue acceptance after an already-running full evaluation
smoke [profile]               Prove router, front door, streaming, and Pi
start [profile]               Start router and front door
pi [profile]                  Start services and launch Pi on chapek-nine
stop                          Stop managed services
```

All services bind to `127.0.0.1`. Logs are under `logs\`; generated presets,
calibration, eval reports, KV slots, and the coordinator adapter are under the
runtime directory.
