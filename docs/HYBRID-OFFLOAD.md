# Hybrid CPU/GPU offload

Chapek Nine does not encode a target machine, fixed VRAM budget, or static
layer-offload recommendation. `init` discovers the host CPU, RAM, CUDA devices,
and available VRAM, then calibrates each downloaded model independently.

## Runtime principle

Dense attention and the most latency-sensitive work should remain on the GPU
when the hardware has headroom. Large sparse expert weights, model layers that
cannot safely fit in VRAM, and capacity-oriented work may remain CPU/RAM
resident. The useful balance depends on the GGUF quantization, context size,
memory bandwidth, GPU architecture, driver behaviour, and concurrent host load;
it cannot be inferred reliably from a model name or a single sizing table.

## Calibration contract

For every installed model, `calibrate-all full` searches the viable layer,
CPU-expert, context, cache-type, batch, and parallelism space. Candidates are
benchmarked with `llama-bench` while Chapek Nine samples host RAM, GPU VRAM,
temperature, and throughput. Unsafe or unstable candidates are rejected. The
selected configuration is persisted with the exact model artifact identity, so
replacing a quantization invalidates its old result.

The optimizer maximises sustained tokens per second subject to measured
headroom. It deliberately avoids configurations that obtain a brief benchmark
win by exhausting host memory, oversubscribing VRAM, or thermally throttling.

## Operational behaviour

- The proxy loads one large worker at a time and releases the previous worker
  before loading the next.
- Per-model KV slots are preserved only for the same model and conversation
  affinity. Cross-model context is carried as structured textual state rather
  than incompatible cache tensors.
- Resource admission checks host and GPU pressure before work starts, waits for
  thermal recovery where appropriate, and records the decision through OpenTelemetry.
- Calibration reports are lifecycle evidence, not universal presets: rerun a
  full calibration after driver, hardware, model, or quantization changes.

## Commands

```powershell
.\harness.ps1 calibrate <profile> full
.\harness.ps1 calibrate-all full
```

`init` runs the full calibration automatically after verified model download.
Calibration history is retained as measured lifecycle evidence; rerun the
affected model's full search after a driver, artifact, or hardware change.
