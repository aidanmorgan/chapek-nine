$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "training\corpus\v1"
$venvPython = Join-Path $root "runtime\coordinator\venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) { $venvPython } elseif ($env:CHAPEK_PYTHON) { $env:CHAPEK_PYTHON } else { "python" }

& node (Join-Path $root "scripts\generate-coordinator-data.mjs") $output
if ($LASTEXITCODE -ne 0) { throw "Coordinator JSONL generation failed." }
& $python (Join-Path $root "training\materialize_corpus.py") --input-dir $output --output-dir $output
if ($LASTEXITCODE -ne 0) { throw "Parquet materialization failed. Install training requirements first." }
