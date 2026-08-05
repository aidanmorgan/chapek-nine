# Windows composition entry point. Command policy lives in the shared Node
# application core; this adapter only selects the native Windows infrastructure.
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { throw "Node.js is required. Install Node.js, then rerun this command." }

& $node.Source (Join-Path $root "scripts\windows-harness.mjs") @Arguments
exit $LASTEXITCODE
