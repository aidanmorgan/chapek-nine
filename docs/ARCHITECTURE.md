# Chapek Nine architecture

Chapek Nine uses a ports-and-adapters interpretation of domain-driven design.
The public OpenAI-compatible proxy is an inbound adapter; llama.cpp, the local
filesystem, OpenTelemetry, Hugging Face, and Pi are outbound adapters. They do
not decide routing or model eligibility.

The bounded contexts are deliberately small and independently testable:

- **Routing** (`deterministic-router`, `routing-objective`, `scheduler`) turns
  a Pi request into a constrained worker plan.
- **Model lifecycle** (`calibration-search`, `probe-model`, `domain/model-readiness`)
  owns measured evidence and eligibility. A worker is eligible only after its
  artifact manifest, CUDA verification, calibration, and capability probe pass.
- **Inference interoperability** (`model-adapters`, `context-state`) translates
  between Pi's canonical protocol and individual worker quirks while preserving
  the canonical transcript.
- **Operations** (`runtime-guard`, `recovery-controller`, `runtime-state`,
  `observability`) admits, measures, recovers, and reports work without altering
  routing policy.
- **Coordinator learning** (`generate-coordinator-data`, `evaluate-coordinator`,
  `coordinator-autopilot`) produces and promotes a constrained learned policy.

Pure decisions live in `scripts/domain`; orchestration that reads/writes files
or runs processes lives in `scripts/application` or the PowerShell composition
root (`harness.ps1`). This prevents model additions from becoming special cases:
add a profile and adapter, then let the lifecycle evidence and routing policy
operate on it through the same contracts.
