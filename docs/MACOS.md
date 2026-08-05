# macOS

Chapek Nine supports native Apple Silicon macOS through `harness.sh`. This is
an infrastructure composition root alongside `harness.ps1`: model profiles,
manifests, adapters, readiness policy, calibration search, proxy, evaluation,
and routing are shared Node domain/application code. The shell-specific layer
is limited to installation, hardware discovery, and process lifecycle.

## Prerequisites

- Apple Silicon macOS with current Xcode Command Line Tools
- Node.js 20 or later
- Homebrew

Run:

```bash
./harness.sh setup
./harness.sh init
./harness.sh pi
```

`setup` installs Homebrew's native Metal-enabled `llama.cpp` formula and local
Node dependencies. `init` downloads every practical profile using the shared,
resumable, checksum-verified Hugging Face downloader; verifies, calibrates,
and probes every worker; runs adapter conformance and the full measured routing
evaluation; rebuilds readiness; and performs a Pi/proxy smoke test. It only
leaves the transparent `chapek-nine` front door on `127.0.0.1:8090` after that
evidence has been recorded. A manifest is accepted only when its repository,
quantization, and files match the configured profile.

## Commands

```bash
./harness.sh doctor
./harness.sh profiles
./harness.sh download glm-flash
./harness.sh download-all
./harness.sh verify glm-flash
./harness.sh calibrate glm-flash full
./harness.sh calibrate-all full
./harness.sh evals glm-flash quick
./harness.sh smoke qwen-coder
./harness.sh start qwen-coder
./harness.sh stop
```

`doctor` reports the unified Metal accelerator separately from system RAM for
description, but calibration deliberately does not score it as separate VRAM:
there is one physical memory pool. Existing `KIMI_MODELS_DIR` and
`KIMI_RUNTIME_DIR` overrides work unchanged.

## Current hardware-bound limitations

The macOS path is designed for Apple Silicon and must be executed on a Mac to
verify a particular Homebrew llama.cpp release, Metal driver, model quant, and
throughput result. QLoRA training is currently CUDA-oriented, so macOS `init`
does not claim coordinator training or promotion: it completes the shared
calibration/probe/evaluation/readiness gates and then uses deterministic
routing safely unless a separately validated coordinator adapter is supplied.
