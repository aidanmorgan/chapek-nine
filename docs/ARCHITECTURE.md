# Chapek Nine architecture

Chapek Nine uses a ports-and-adapters interpretation of domain-driven design.
The public OpenAI-compatible proxy is an inbound adapter; llama.cpp, the local
filesystem, OpenTelemetry, Hugging Face, and Pi are outbound adapters. They do
not decide routing or model eligibility.

The bounded contexts are deliberately small and independently testable:

- **Routing** (`deterministic-router`, `routing-objective`, `scheduler`) turns
  a Pi request into a constrained worker plan.
- **Model lifecycle** (`calibration-search`, `probe-model`, `domain/model-readiness`)
  owns measured evidence and admission. A public worker must pass its artifact
  manifest, CUDA verification, calibration, and complete Pi protocol probe;
  an internal specialist has a narrower, explicitly recorded contract.
- **Inference interoperability** (`model-adapters`, `context-state`) translates
  between Pi's canonical protocol and individual worker quirks while preserving
  the canonical transcript.
- **Operations** (`runtime-guard`, `recovery-controller`, `runtime-state`,
  `observability`) admits, measures, recovers, and reports work without altering
  routing policy.
- **Coordinator learning** (`generate-coordinator-data`, `evaluate-coordinator`,
  `coordinator-autopilot`) produces and promotes a constrained learned policy.

Pure decisions live in `scripts/domain`; use-case sequencing lives in
`scripts/application/chapek-command-core.mjs`. The core depends on a platform
port only. `scripts/infrastructure/os/windows` and
`scripts/infrastructure/os/macos` implement that port for native discovery,
installation, process supervision, and accelerator execution. `harness.ps1`
and `harness.sh` are intentionally thin composition entry points. This prevents
model and operating-system additions from becoming special cases: add a profile
or platform adapter, then let the same lifecycle evidence and routing policy
operate through the port contract.
