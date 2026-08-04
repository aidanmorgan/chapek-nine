param(
    [int]$PollSeconds = 30
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:KIMI_RUNTIME_DIR) { $env:KIMI_RUNTIME_DIR } else { Join-Path $root "runtime" }
$report = Join-Path $runtime "routing-evals.json"

while (-not (Test-Path -LiteralPath $report)) {
    Start-Sleep -Seconds $PollSeconds
}

# The evaluator publishes by atomic rename. Validate the completed document
# before consuming it so a hand-written or partial file cannot promote a model.
$evaluation = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
if (-not $evaluation.modelArtifacts -or -not $evaluation.rows -or @($evaluation.rows).Count -eq 0) {
    throw "Routing evaluation report is incomplete: $report"
}

& (Join-Path $root "harness.ps1") train-coordinator
if ($LASTEXITCODE -ne 0) { throw "Coordinator training failed." }
& (Join-Path $root "harness.ps1") evaluate-coordinator
if ($LASTEXITCODE -ne 0) { throw "Coordinator promotion evaluation failed." }
& (Join-Path $root "harness.ps1") smoke
if ($LASTEXITCODE -ne 0) { throw "Pi smoke verification failed." }

Write-Host "Measured routing, coordinator training, promotion evaluation, and Pi smoke verification completed."
