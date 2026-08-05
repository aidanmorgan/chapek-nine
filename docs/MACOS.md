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
resumable, checksum-verified Hugging Face downloader; verifies each model;
runs the measurement-driven calibration serially; then starts llama.cpp and
the transparent `chapek-nine` front door on `127.0.0.1:8090`.

## Commands

```bash
./harness.sh doctor
./harness.sh profiles
./harness.sh download glm-flash
./harness.sh download-all
./harness.sh verify glm-flash
./harness.sh calibrate glm-flash full
./harness.sh calibrate-all full
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
throughput result. QLoRA training currently remains a CUDA-oriented workflow;
the proxy continues safely with deterministic routing unless a compatible
coordinator adapter is supplied. The shared evaluation and coordinator policy
are unchanged, but a full model/evaluation run should be performed locally
before admitting a Mac installation to production work.
