param(
    [int]$PollSeconds = 30
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = if ($env:KIMI_RUNTIME_DIR) { $env:KIMI_RUNTIME_DIR } else { Join-Path $root "runtime" }
$models = if ($env:KIMI_MODELS_DIR) { $env:KIMI_MODELS_DIR } else { Join-Path $root "models" }
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

# An evaluation can take many hours. If a worker finished downloading during
# that run, measure its complete admission lifecycle now and merge its rows
# into the same evidence report instead of throwing away the completed suite.
$profiles = Get-Content -Raw -LiteralPath (Join-Path $root "config\profiles.json") | ConvertFrom-Json
$measured = [System.Collections.Generic.HashSet[string]]::new([string[]]@($evaluation.models))
foreach ($property in $profiles.profiles.PSObject.Properties) {
    $name = $property.Name
    $profile = $property.Value
    if (-not $profile.supported -or $measured.Contains($name)) { continue }
    $modelDirectory = Join-Path $models $name
    $manifestPath = Join-Path $modelDirectory "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $files = @($manifest.files | ForEach-Object { Join-Path $modelDirectory $_.path })
    if (
        $manifest.repo -ne $profile.repo -or
        $manifest.quant -ne $profile.quant -or
        -not $files.Count -or
        @($files | Where-Object { -not (Test-Path -LiteralPath $_) }).Count
    ) { continue }

    Write-Host "A newly downloaded worker '$name' needs admission evidence; verifying, calibrating, probing, and evaluating it."
    & (Join-Path $root "harness.ps1") verify $name
    if ($LASTEXITCODE -ne 0) { throw "Verification failed for newly downloaded worker '$name'." }
    & (Join-Path $root "harness.ps1") calibrate $name full
    if ($LASTEXITCODE -ne 0) { throw "Calibration failed for newly downloaded worker '$name'." }
    & (Join-Path $root "harness.ps1") probe $name
    if ($LASTEXITCODE -ne 0) { throw "Capability probe failed for newly downloaded worker '$name'." }
    & (Join-Path $root "harness.ps1") evals $name full
    if ($LASTEXITCODE -ne 0) { throw "Routing evaluation failed for newly downloaded worker '$name'." }
    $measured.Add($name) | Out-Null
}

# Reload after any targeted merge so QLoRA training sees every measured worker.
$evaluation = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
& (Join-Path $root "harness.ps1") train-coordinator
if ($LASTEXITCODE -ne 0) { throw "Coordinator training failed." }
& (Join-Path $root "harness.ps1") evaluate-coordinator
if ($LASTEXITCODE -ne 0) { throw "Coordinator promotion evaluation failed." }
& (Join-Path $root "harness.ps1") smoke
if ($LASTEXITCODE -ne 0) { throw "Pi smoke verification failed." }

Write-Host "Measured routing, coordinator training, promotion evaluation, and Pi smoke verification completed."
