# CPU/GPU hybrid inference design

Research date: 2026-08-02  
Target host: RTX 4080 SUPER (16 GiB VRAM), 31.1 GiB system RAM, Windows

## What the handoff actually does

Sparse mixture-of-experts models have two materially different classes of
weights:

- Attention, recurrent state, embeddings, routers, shared experts, and dense
  layers are touched for every token. These have high reuse or high arithmetic
  intensity and belong on the GPU.
- Routed expert matrices account for most total parameters, but only a small
  subset is selected for each token. At batch size one their computation is
  dominated by reading weights. They are the best tensors to leave in system
  RAM and execute with optimized CPU kernels.

This is tensor placement, not merely putting the first N transformer layers on
CPU. Whole-layer splitting leaves attention on CPU for spilled layers and
usually wastes the GPU on sparse models.

Current llama.cpp exposes three useful strategies:

1. `-ngl all --cpu-moe`: place all routed MoE tensors in CPU memory while
   keeping the always-used tensors on GPU. This is the conservative default
   for the sparse Qwen profile.
2. `--fit on --fit-target 1536`: automatic placement. This is the default for
   dense profiles and remains an override for MoE benchmarking.
3. `-ngl all --n-cpu-moe N`: keep experts for the first N MoE layers on CPU and
   place the remaining experts on GPU. The measured Kimi Q2 default uses
   `N=7` across its 27 blocks on the 16 GiB RTX 4080 SUPER.

Do not combine automatic fit with an explicit `-ngl`, `-ot`, `--cpu-moe`, or
`--n-cpu-moe`. Explicit placement disables the part of automatic fitting that
would otherwise calculate the memory layout.

## Harness modes

The normal path is measured calibration rather than a hand-picked split:

```powershell
.\harness.ps1 calibrate kimi-linear quick
.\harness.ps1 calibrate kimi-linear full
```

`quick` tries the nearest expert-split and batch candidates; `full` widens the
grid and repeats each benchmark. The runner samples RAM and VRAM throughout,
records prompt/decode throughput, and saves the winner in
`runtime\calibration.json`.

Scoring uses **incremental** candidate consumption: RAM/VRAM already occupied
by Codex, browsers, and the desktop is baseline host overhead and is not
charged to the model. Estimated headroom is total capacity minus the model's
incremental high-water mark, a 4 GiB/12% OS reserve, and a 512 MiB/4% display
reserve. Windows `freemem()` can briefly approach zero while mmap pages are
reclaimed, so it is not an absolute rejection criterion; only a prolonged
sub-32 MiB collapse triggers the emergency stop.

The latest quick run on the target host selected `n-cpu-moe=7`, batch 256,
ubatch 128 and measured approximately 186 prompt tokens/s and 97 decode
tokens/s. It estimated 11.2 GiB of model-relative RAM headroom and 1.8 GiB of
model-relative VRAM headroom.

Manual overrides remain available for diagnosis:

Automatic placement:

```powershell
$env:KIMI_OFFLOAD_MODE = "auto"
.\harness.ps1 verify kimi-linear
```

Force every routed expert onto CPU:

```powershell
$env:KIMI_OFFLOAD_MODE = "cpu-moe"
.\harness.ps1 verify kimi-linear
```

Tune a partial expert split:

```powershell
$env:KIMI_OFFLOAD_MODE = "partial-cpu-moe"
$env:KIMI_N_CPU_MOE = "7"
.\harness.ps1 verify kimi-linear
```

For partial mode, start with a high value and reduce it until VRAM usage is near
14.5 GiB without CUDA allocation failures. Benchmark multiple values because
expert tensor sizes are not necessarily uniform across layers.

Automatic mode targets about 1.5 GiB of free VRAM. Explicit CPU-MoE modes do
not use the automatic fitter: they instead remove selected expert tensors from
VRAM, limit prompt batch buffers, use a single parallel slot, and keep the KV
cache with the GPU-eligible work. Keeping KV on CPU is possible but normally
harms prompt processing and token generation.

## Windows-specific behavior

llama.cpp has native Windows CUDA builds and Windows memory mapping. WSL is not
required for the upstream runtime.

NVIDIA's Windows driver can transparently spill VRAM allocations into system
memory. This is different from intentional llama.cpp tensor placement: it
moves GPU allocations over PCIe and can make a configuration look as though it
fits while performing badly. For repeatable tuning, set **CUDA - Sysmem
Fallback Policy** to **Prefer No Sysmem Fallback** for `llama-server.exe` in
NVIDIA Control Panel. The harness keeps a 1536 MiB margin when automatic fit is
selected; explicit CPU-MoE placement relies on the much larger space recovered
by keeping expert tensors off the GPU. Kimi Linear uses F16 for both caches:
its value-head width (72) is not divisible by the Q8 block size, and this
architecture requires matching K/V cache types. The other built-in profiles
use Q8 for both caches.

Memory-mapped GGUF is the correct default. It lets Windows page model data from
the file and retain hot pages in its file cache. It does not eliminate the
memory requirement. If the active working set substantially exceeds physical
RAM, random expert access causes continual SSD page faults.

## Capacity boundary on this host

| Model | Small useful representation | Local status |
| --- | ---: | --- |
| Gemma 4 E4B | about 5 GiB | Fits mostly or fully in VRAM |
| GLM-4.7-Flash 30B-A3B | 17.52 GB at UD-Q4_K_XL | Strong GLM hybrid candidate |
| Qwen3 Coder 30B-A3B | about 19 GiB | Good hybrid candidate |
| Kimi Linear 48B-A3B | 18.0 GB at Q2_K | Calibrated hybrid default |
| Kimi Linear 48B-A3B | 21.3 GB at Q3_K_S | Loads with paging; use more than 32 GiB RAM |
| Granite 4.1 30B | about 18 GiB at Q4 | Dense partial offload |
| Kimi K2.6 | 207-544 GiB | Does not fit 31.1 GiB RAM |
| Kimi K3 | 2.8T total parameters | No llama.cpp port; terabyte-class memory |

CPU/GPU handoff solves **model larger than VRAM but fitting in RAM plus VRAM**.
It cannot turn a 200 GB or multi-terabyte checkpoint into a practical 31 GB
machine workload. SSD-backed mmap may technically begin inference for a model
somewhat larger than RAM, but it is not a substitute for hundreds of gigabytes
of DRAM and is unsuitable for an interactive engineering agent.

## Alternative runtimes considered

### ik_llama.cpp

This llama.cpp fork has fused MoE CPU kernels, `--cpu-moe`,
`--n-cpu-moe`, active-expert offload, and stronger hybrid performance. It is a
credible optional backend for supported models. Its documentation warns that
some row-interleaved quants and Unsloth `_XL` files can interact poorly with
CUDA, and some graph-parallel hybrid configurations can produce invalid output.
Upstream llama.cpp remains the default because correctness and model coverage
matter more than a speculative speed gain.

### KTransformers

KTransformers formalizes the same arithmetic-intensity placement: expert GEMV
on CPU and attention/MLA/KV on GPU. It is strongest on very large MoE models
with enough DRAM. Its own sizing table still requires approximately the model's
quantized size in DRAM (for example, roughly 382 GiB for a 377 GiB DeepSeek
quant), and native Windows is currently deprecated in favor of WSL. It does not
remove this host's RAM limit.

### Experimental hot-expert caches

There are active llama.cpp RFCs and forks that cache frequently selected
experts in spare VRAM. Early reports show meaningful gains, but the feature is
not in supported upstream releases. The harness does not depend on it yet.

## Primary references

- llama.cpp CLI parameters:
  https://github.com/ggml-org/llama.cpp/blob/master/tools/cli/README.md
- llama.cpp server parameters and router:
  https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Automatic fitting design and interaction with explicit placement:
  https://github.com/ggml-org/llama.cpp/discussions/18049
- Existing CPU expert placement and proposed expert cache:
  https://github.com/ggml-org/llama.cpp/issues/20757
- ik_llama.cpp hybrid documentation:
  https://github.com/ikawrakow/ik_llama.cpp
- KTransformers heterogeneous design and memory requirements:
  https://github.com/kvcache-ai/ktransformers
- mmap behavior for models larger than RAM:
  https://github.com/ggml-org/llama.cpp/discussions/18758
- Official Kimi K3 architecture:
  https://github.com/MoonshotAI/Kimi-K3
