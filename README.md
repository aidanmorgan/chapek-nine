# Chapek Nine

Chapek Nine is a native-Windows engineering harness for
[Pi](https://pi.dev) backed by [llama.cpp](https://github.com/ggml-org/llama.cpp)
and CUDA. Pi sees one OpenAI-compatible model named `chapek-nine`; a private
front door routes work across locally installed Kimi, Qwen, Gemma, and Granite
GGUFs, adapts requests for each family, and switches one worker at a time so
the workers can share a single GPU.

## Quick start

```powershell
cd C:\dev\projects\kimi
.\harness.ps1 bootstrap
.\harness.ps1 pi
```

`bootstrap` installs the project-local Pi package and the official native
Windows CUDA llama.cpp bundle, downloads and verifies the selected worker,
calibrates CPU/GPU placement, downloads the small coordinator base, trains its
LoRA adapter, and runs an end-to-end Pi smoke test. Existing Python 3.10 or
newer is reused; set `CHAPEK_PYTHON` if it is not on `PATH`.

The default worker download is approximately 18 GB. Downloads are segmented,
resumable, checksum-verified against Hugging Face LFS metadata, and retry
transient timeouts or early CDN EOFs without a cumulative time limit. A
per-profile lock prevents concurrent writers, and a valid older cache file is
adopted by NTFS hard link when possible.

Models and generated runtime data can live on another disk:

```powershell
$env:KIMI_MODELS_DIR = "D:\chapek-models"
$env:KIMI_RUNTIME_DIR = "D:\chapek-runtime"
.\harness.ps1 bootstrap
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
the measured developer-task routing evals. Its suite combines 24 hand-written
tasks with 360 cross-domain engineering task families, yielding 7,680
deterministic routing examples with entire task families held out for
validation. It learns only to produce a small
worker plan; it never executes tools or solves the task itself. See
[the orchestration design](docs/LOCAL-ORCHESTRATION.md).

## CPU/GPU calibration

```powershell
.\harness.ps1 calibrate kimi-linear quick
.\harness.ps1 calibrate kimi-linear full
```

Calibration benchmarks candidate MoE expert splits, batch sizes, and dense
model fit targets using `llama-bench`, while sampling RAM and VRAM. It selects
the highest measured prompt/decode throughput that retains model-relative
headroom. Memory already occupied by Codex and the desktop is treated as host
overhead rather than charged to the model; a small OS/display reserve and a
prolonged-collapse guard remain.

On the test RTX 4080 SUPER (16 GiB) / 31 GiB RAM machine, the current Kimi
Linear Q2 result keeps seven early routed-expert layers on the CPU and sends
the later experts plus eligible dense/attention work to CUDA:

```text
--fit off --n-gpu-layers all --n-cpu-moe 7
```

Measured quick-calibration throughput was about 186 prompt tokens/s and 97
decode tokens/s. The generated `calibration.json` is machine-specific and is
applied automatically. Dense models use llama.cpp automatic layer fitting
instead. See [the hybrid-offload notes](docs/HYBRID-OFFLOAD.md).

Native Windows CUDA is the preferred path and is verified with
`llama-server --list-devices`; neither WSL nor a system-wide CUDA toolkit is
required. WSL remains an optional fallback for unsupported experimental
runtimes.

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

Start a large specialist download without keeping the current terminal open:

```powershell
.\harness.ps1 download-background glm-flash
Get-Content -Wait -LiteralPath .\logs\download-glm-flash.out.log
```

The background process uses the same per-profile lock, segmented resume, and
SHA-256 validation as a foreground download. `status` reports the job and log
path. If it is interrupted, rerun the same command to resume; it never starts
a second writer for that profile.

`glm-flash` is GLM-4.7-Flash 30B-A3B at UD-Q4_K_XL (17.52 GB), the
strongest current GLM variant that fits this machine. The newer GLM-5.2 and
full GLM-4.7 checkpoints are 744B-A40B and 355B-A32B respectively, so they are
outside the host's RAM capacity. The GLM adapter disables unbounded thinking
for reliable Pi-visible answers, applies the model-card repeat/min-p settings,
and retains native tool calling.

Select a direct/default profile or point one at another compatible GGUF:

```powershell
.\harness.ps1 use qwen-coder
.\harness.ps1 add gemma4 owner/repository Q4_K_M
```

## Commands

```text
setup                         Install Pi and native CUDA llama.cpp
doctor                        Show hardware, CUDA, runtime, and model status
profiles                      List worker profiles
use <profile>                 Select the default/fallback worker
add <name> <repo> [quant]     Add or update a GGUF profile
download [profile]            Resume, download, and verify a worker
download-background [profile] Run a resumable worker download in the background
verify [profile]              Prove direct CUDA inference
calibrate [profile] [mode]    Tune CPU/GPU placement (quick or full)
evals [quick|full]            Rank installed workers on developer tasks
train-coordinator             Generate data and train/convert coordinator LoRA
smoke [profile]               Prove router, front door, streaming, and Pi
bootstrap [profile]           Complete first-run workflow
start [profile]               Start router, coordinator, and front door
pi [profile]                  Start services and launch Pi on chapek-nine
status                        Show managed service state
stop                          Stop managed services
```

All services bind to `127.0.0.1`. Logs are under `logs\`; generated presets,
calibration, eval reports, KV slots, and the coordinator adapter are under the
runtime directory.
