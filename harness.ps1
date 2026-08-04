[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("setup", "init", "doctor", "profiles", "use", "add", "onboard", "quant", "quant-report", "catalogue", "discover", "sandbox", "download", "download-all", "download-background", "verify", "verify-all", "calibrate", "calibrate-all", "calibration-status", "probe", "conformance", "experiment", "evals", "evaluate-coordinator", "improve-coordinator", "coordinator-autopilot", "train-coordinator", "smoke", "bootstrap", "start", "pi", "status", "stop", "help")]
    [string]$Command = "help",
    [Parameter(Position = 1)]
    [string]$Profile,
    [Parameter(Position = 2)]
    [string]$Value,
    [Parameter(Position = 3)]
    [string]$Extra
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$ConfigPath = Join-Path $Root "config\profiles.json"
$ModelsDir = if ($env:KIMI_MODELS_DIR) {
    [System.IO.Path]::GetFullPath($env:KIMI_MODELS_DIR)
} else {
    Join-Path $Root "models"
}
$RuntimeDir = if ($env:KIMI_RUNTIME_DIR) {
    [System.IO.Path]::GetFullPath($env:KIMI_RUNTIME_DIR)
} else {
    Join-Path $Root "runtime"
}
$StatePath = if ($env:KIMI_RUNTIME_DIR) {
    Join-Path $RuntimeDir ".state.json"
} else {
    Join-Path $Root ".state.json"
}
$LogDir = if ($env:KIMI_RUNTIME_DIR) {
    Join-Path $RuntimeDir "logs"
} else {
    Join-Path $Root "logs"
}
$ServerLog = Join-Path $LogDir "llama-server.log"
$Port = 8080
$ProxyPort = 8090
$ProxyLog = Join-Path $LogDir "model-proxy.log"
$KvCacheDir = Join-Path $RuntimeDir "kv-cache"
$CalibrationPath = Join-Path $RuntimeDir "calibration.json"
$CoordinatorConfigPath = Join-Path $Root "config\coordinator.json"
$CoordinatorPort = 8081
$CoordinatorLog = Join-Path $LogDir "coordinator.log"
$DownloadJobsDir = Join-Path $RuntimeDir "downloads"
$env:LLAMA_CACHE = Join-Path $ModelsDir "cache"

function Read-Profiles {
    Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
}

function Write-Profiles($Config) {
    $Config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding utf8
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-SelectedProfile {
    $config = Read-Profiles
    $name = if ($Profile) { $Profile } else { $config.default }
    $entry = $config.profiles.PSObject.Properties[$name]
    if (-not $entry) { throw "Unknown profile '$name'. Run: .\harness.ps1 profiles" }
    [pscustomobject]@{ Name = $name; Config = $entry.Value }
}

function Get-Gpu {
    $line = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if (-not $line) { return $null }
    $parts = $line -split ","
    [pscustomobject]@{ Name = $parts[0].Trim(); VramMiB = [int]$parts[1].Trim() }
}

function Get-RamGiB {
    try {
        $bytes = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory
        return [math]::Round($bytes / 1GB, 1)
    } catch {
        if (Get-Command node -ErrorAction SilentlyContinue) {
            $nodeBytes = & node -e "process.stdout.write(String(require('os').totalmem()))" 2>$null
            if ($nodeBytes -match "^\d+$") {
                return [math]::Round(([double]$nodeBytes) / 1GB, 1)
            }
        }
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        $line = systeminfo.exe 2>$null | Select-String "Total Physical Memory" | Select-Object -First 1
        $ErrorActionPreference = $previousPreference
        if ($line -and $line -match "([\d,]+)\s+MB") {
            return [math]::Round(([double]($Matches[1] -replace ",", "")) / 1024, 1)
        }
        return $null
    }
}

function Find-LlamaServer {
    if ($env:KIMI_LLAMA_SERVER -and (Test-Path -LiteralPath $env:KIMI_LLAMA_SERVER)) {
        return (Resolve-Path -LiteralPath $env:KIMI_LLAMA_SERVER).Path
    }
    if ($env:KIMI_LLAMA_DIR) {
        $override = Join-Path $env:KIMI_LLAMA_DIR "llama-server.exe"
        if (Test-Path -LiteralPath $override) { return (Resolve-Path -LiteralPath $override).Path }
    }
    $local = Get-ChildItem -Path $RuntimeDir -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($local) { return $local.FullName }
    $cmd = Get-Command "llama-server.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command "llama-server" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-LlamaCli {
    if ($env:KIMI_LLAMA_CLI -and (Test-Path -LiteralPath $env:KIMI_LLAMA_CLI)) {
        return (Resolve-Path -LiteralPath $env:KIMI_LLAMA_CLI).Path
    }
    if ($env:KIMI_LLAMA_DIR) {
        $override = Join-Path $env:KIMI_LLAMA_DIR "llama-cli.exe"
        if (Test-Path -LiteralPath $override) { return (Resolve-Path -LiteralPath $override).Path }
    }
    $local = Get-ChildItem -Path $RuntimeDir -Recurse -Filter "llama-cli.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($local) { return $local.FullName }
    $cmd = Get-Command "llama-cli.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command "llama-cli" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-LlamaBench {
    if ($env:KIMI_LLAMA_DIR) {
        $override = Join-Path $env:KIMI_LLAMA_DIR "llama-bench.exe"
        if (Test-Path -LiteralPath $override) { return (Resolve-Path -LiteralPath $override).Path }
    }
    $local = Get-ChildItem -Path $RuntimeDir, (Join-Path $Root "runtime") -Recurse `
        -Filter "llama-bench.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($local) { return $local.FullName }
    $cmd = Get-Command "llama-bench.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-CalibratedSettings($Selected) {
    if (-not (Test-Path -LiteralPath $CalibrationPath)) { return $null }
    try {
        $calibration = Get-Content -Raw -LiteralPath $CalibrationPath | ConvertFrom-Json
        $entry = $calibration.profiles.PSObject.Properties[$Selected.Name]
        if (-not $entry) { return $null }
        $localModel = Get-LocalModel $Selected
        if (
            -not $localModel -or
            -not (Test-Path -LiteralPath $localModel.ModelPath) -or
            [int64]$entry.Value.modelSizeBytes -ne (Get-Item -LiteralPath $localModel.ModelPath).Length
        ) {
            return $null
        }
        return $entry.Value.selected
    } catch {
        Write-Warning "Ignoring invalid calibration file '$CalibrationPath': $($_.Exception.Message)"
        return $null
    }
}

function Get-EffectiveValue($Selected, [string]$Name, $Fallback) {
    $calibrated = Get-CalibratedSettings $Selected
    if ($calibrated) {
        $property = $calibrated.PSObject.Properties[$Name]
        if ($property -and $null -ne $property.Value) { return $property.Value }
    }
    $configured = $Selected.Config.PSObject.Properties[$Name]
    if ($configured -and $null -ne $configured.Value) { return $configured.Value }
    return $Fallback
}

function Test-LlamaCapabilities([string]$Executable) {
    if (-not $Executable) { return $false }
    $helpText = (& $Executable --help 2>&1) -join "`n"
    return (
        $helpText -match "--models-dir" -and
        $helpText -match "--models-preset" -and
        $helpText -match "--cpu-moe" -and
        $helpText -match "--n-cpu-moe" -and
        $helpText -match "--fit-target"
    )
}

function Show-Doctor {
    $gpu = Get-Gpu
    $ram = Get-RamGiB
    $server = Find-LlamaServer
    $selected = Get-SelectedProfile
    $offloadMode = if ($env:KIMI_OFFLOAD_MODE) { $env:KIMI_OFFLOAD_MODE } else { $selected.Config.offloadMode }
    Write-Host "Local Pi hybrid harness"
    Write-Host "  GPU:        $(if ($gpu) { "$($gpu.Name) ($([math]::Round($gpu.VramMiB / 1024, 1)) GiB VRAM)" } else { "not detected" })"
    Write-Host "  RAM:        $(if ($ram) { "$ram GiB" } else { "unknown (run this shell with normal WMI access)" })"
    Write-Host "  llama.cpp:  $(if ($server) { $server } else { "not installed" })"
    Write-Host "  Node:       $(if (Get-Command node -ErrorAction SilentlyContinue) { node --version } else { "not installed" })"
    Write-Host "  Pi:         $(if (Test-Path (Join-Path $Root "node_modules\.bin\pi.cmd")) { "local install ready" } else { "not installed; run setup" })"
    $offloadDetail = if ($offloadMode -eq "partial-cpu-moe") {
        $n = if ($env:KIMI_N_CPU_MOE) { $env:KIMI_N_CPU_MOE } else { $selected.Config.cpuMoeLayers }
        "$offloadMode, $n CPU expert layers"
    } else {
        $offloadMode
    }
    Write-Host "  Profile:    $($selected.Name) ($offloadDetail)"
    Write-Host "  Model dir:  $ModelsDir"
    Write-Host "  Models:     $((Get-ChildItem $ModelsDir -Recurse -Filter *.gguf -ErrorAction SilentlyContinue).Count) GGUF file(s)"
    $localModel = Get-LocalModel $selected
    if ($localModel) {
        Write-Host "  Selected:   ready from $($localModel.Source)"
    }
    $segmentState = Get-ChildItem $ModelsDir -Recurse -File -Filter "*.partial.state.json" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($segmentState) {
        try {
            $downloadState = Get-Content -Raw -LiteralPath $segmentState.FullName | ConvertFrom-Json
            $received = ($downloadState.completed | Measure-Object -Sum).Sum
            Write-Host "  Download:   $([math]::Round($received / 1GB, 2)) GiB received ($([math]::Round(100 * $received / $downloadState.expectedSize, 1))%)"
        } catch {
            Write-Host "  Download:   segmented download state is being updated"
        }
    }
    $partial = Get-ChildItem $ModelsDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "\.partial$|\.downloadInProgress$" } |
        Select-Object -First 1
    if ($partial -and -not $segmentState) {
        Write-Host "  Download:   $([math]::Round($partial.Length / 1GB, 2)) GiB received ($($partial.Name))"
    }
    if (Test-Path -LiteralPath $DownloadJobsDir) {
        $jobs = Get-ChildItem -LiteralPath $DownloadJobsDir -File -Filter "*.json" -ErrorAction SilentlyContinue
        foreach ($jobFile in $jobs) {
            try {
                $job = Get-Content -Raw -LiteralPath $jobFile.FullName | ConvertFrom-Json
                $jobProcess = Get-Process -Id $job.pid -ErrorAction SilentlyContinue
                $state = if ($jobProcess -and $jobProcess.ProcessName -in @("powershell", "pwsh")) { "running" } else { "finished; rerun to resume if needed" }
                Write-Host "  Background: $($job.profile) $state (PID $($job.pid)); log: $($job.outputLog)"
            } catch {
                Write-Warning "Could not read background download state '$($jobFile.FullName)'."
            }
        }
    }
    if ($server) {
        $devices = & $server --list-devices 2>&1
        Write-Host "  CUDA:       $(if (($devices -join "`n") -match "CUDA") { "ready" } else { "not present in this llama.cpp build" })"
        Write-Host "  Hybrid:     $(if (Test-LlamaCapabilities $server) { "router + CPU-MoE controls ready" } else { "required flags missing" })"
    }
}

function Show-Profiles {
    $config = Read-Profiles
    foreach ($p in $config.profiles.PSObject.Properties) {
        $marker = if ($p.Name -eq $config.default) { "*" } else { " " }
        $support = if ($p.Value.supported) { "supported" } else { "blocked upstream" }
        Write-Host "$marker $($p.Name.PadRight(12)) $support  $($p.Value.displayName)"
        Write-Host "    repo=$($p.Value.repo) quant=$($p.Value.quant) context=$($p.Value.context)"
    }
}

function Set-Profile([string]$Name) {
    if (-not $Name) { throw "Usage: .\harness.ps1 use <profile>" }
    $config = Read-Profiles
    if (-not $config.profiles.PSObject.Properties[$Name]) { throw "Unknown profile '$Name'." }
    $config.default = $Name
    Write-Profiles $config
    Write-Host "Selected '$Name'."
}

function Add-ProfileRepo([string]$Name, [string]$Repo, [string]$Quant) {
    if (-not $Name -or -not $Repo) { throw "Usage: .\harness.ps1 add <profile> <owner/repo> [quant]" }
    $config = Read-Profiles
    $entry = $config.profiles.PSObject.Properties[$Name]
    if (-not $entry) { throw "Unknown profile '$Name'." }
    $entry.Value.repo = $Repo
    if ($Quant) { $entry.Value.quant = $Quant }
    foreach ($property in @("file", "sizeBytes", "sha256")) {
        $entry.Value.PSObject.Properties.Remove($property)
    }
    Write-Profiles $config
    Write-Host "Updated '$Name' to ${Repo}:$($entry.Value.quant)."
}

function Install-Harness {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node/npm is required." }
    Push-Location $Root
    try {
        & npm install --ignore-scripts
        if ($LASTEXITCODE -ne 0) {
            throw "Project-local Pi installation failed. Resolve npm installation before launching the harness."
        }
    } finally { Pop-Location }
    if (-not (Find-LlamaServer)) {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host "Installing llama.cpp through WinGet..."
            & $winget.Source install llama.cpp --accept-package-agreements --accept-source-agreements
        }
        if (-not (Find-LlamaServer)) {
            Write-Host "Installing the official Windows CUDA 12.4 bundle locally..."
            & (Join-Path $Root "scripts\install-llama.ps1") -Cuda "12.4"
        }
    }
    $server = Find-LlamaServer
    $devices = & $server --list-devices 2>&1
    if (($devices -join "`n") -notmatch "CUDA" -or -not (Test-LlamaCapabilities $server)) {
        Write-Warning "The installed llama.cpp build lacks CUDA or required router/CPU-MoE controls. Installing the official CUDA bundle locally."
        & (Join-Path $Root "scripts\install-llama.ps1") -Cuda "12.4"
    }
    $server = Find-LlamaServer
    if (-not (Test-LlamaCapabilities $server)) {
        throw "llama.cpp is missing router, CPU-MoE, or automatic-fit controls required by this harness."
    }
    Show-Doctor
}

function Assert-ProfileCapacity($Selected) {
    $gpu = Get-Gpu
    $ram = Get-RamGiB
    if (-not $Selected.Config.supported) {
        throw "$($Selected.Config.displayName) is capability-gated. $($Selected.Config.notes)"
    }
    if (-not $Selected.Config.repo) {
        throw "Profile '$($Selected.Name)' has no GGUF repo. Run: .\harness.ps1 add $($Selected.Name) <owner/repo> [quant]"
    }
    if (-not $gpu) { Write-Warning "No NVIDIA GPU detected; llama.cpp will run on CPU." }
}

function Get-LocalModel($Selected) {
    $profileDir = Join-Path $ModelsDir $Selected.Name
    $manifestPath = Join-Path $profileDir "manifest.json"
    if (Test-Path -LiteralPath $manifestPath) {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
        if ($manifest.repo -eq $Selected.Config.repo -and $manifest.quant -eq $Selected.Config.quant) {
            $files = @($manifest.files | ForEach-Object { Join-Path $profileDir $_.path })
            if ($files.Count -gt 0 -and @($files | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0) {
                return [pscustomobject]@{
                    ModelId = $manifest.modelId
                    ModelPath = $files[0]
                    Files = $files
                    ManifestPath = $manifestPath
                    Source = "profile"
                }
            }
        }
    }
    return $null
}

function Download-Profile {
    $selected = Get-SelectedProfile
    Assert-ProfileCapacity $selected
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node is required for verified model downloads." }
    $profileDir = Join-Path $ModelsDir $selected.Name
    Write-Host "Downloading $($selected.Config.repo):$($selected.Config.quant) with resume and SHA-256 validation..."
    & node (Join-Path $Root "scripts\download-hf.mjs") $selected.Config.repo $selected.Config.quant $profileDir
    if ($LASTEXITCODE -ne 0) { throw "Verified model download failed with exit code $LASTEXITCODE." }
    Write-Host "Model is ready under $profileDir."
}

function Download-AllProfiles {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node is required for verified model downloads." }
    $config = Read-Profiles
    $savedProfile = $script:Profile
    $results = @()
    try {
        foreach ($property in $config.profiles.PSObject.Properties) {
            $name = $property.Name
            $entry = $property.Value
            if (-not $entry.supported) {
                Write-Warning "Skipping capability-gated profile '$name': $($entry.notes)"
                $results += [pscustomobject]@{ profile = $name; status = "skipped"; reason = "capability-gated" }
                continue
            }
            $script:Profile = $name
            try {
                Download-Profile
                $results += [pscustomobject]@{ profile = $name; status = "ready"; reason = "verified" }
            } catch {
                Write-Warning "Download failed for '$name': $($_.Exception.Message)"
                $results += [pscustomobject]@{ profile = $name; status = "failed"; reason = $_.Exception.Message }
            }
        }
    } finally {
        $script:Profile = $savedProfile
    }
    $results | Format-Table -AutoSize | Out-Host
    $failed = @($results | Where-Object { $_.status -eq "failed" }).Count
    if ($failed) { throw "$failed configured model download(s) failed." }
}

function New-OnboardProfile([string]$Name, [string]$Repo, [string]$Quant) {
    if (-not $Name -or -not $Repo -or -not $Quant) { throw "Usage: .\harness.ps1 onboard <name> <owner/repo> <quant>" }
    if ($Name -notmatch "^[a-z0-9][a-z0-9-]{1,48}$") { throw "Profile name must use lowercase letters, digits, and hyphens." }
    $config = Read-Profiles
    if ($config.profiles.PSObject.Properties[$Name]) { throw "Profile '$Name' already exists; use add to update it." }
    $entry = [pscustomobject]@{
        displayName = "$Name (unprobed)"
        family = "generic"
        repo = $Repo
        quant = $Quant
        context = 4096
        hybridMoe = $false
        offloadMode = "auto"
        supported = $true
        notes = "Generated onboarding profile. Download, calibrate, probe, and run compatibility evals before routing production Pi work here."
    }
    $config.profiles | Add-Member -NotePropertyName $Name -NotePropertyValue $entry
    Write-Profiles $config
    Write-Host "Created '$Name'. Next: download, calibrate, probe, then evaluate it before using it in routing."
}

function New-QuantVariant([string]$Name, [string]$Quant) {
    if (-not $Name -or -not $Quant) { throw "Usage: .\harness.ps1 quant <profile> <quant>" }
    $config = Read-Profiles; $source = $config.profiles.PSObject.Properties[$Name]
    if (-not $source) { throw "Unknown profile '$Name'." }
    $variant = "$Name-$($Quant.ToLowerInvariant() -replace '[^a-z0-9]+','-')".Trim('-')
    if (-not $config.profiles.PSObject.Properties[$variant]) {
        $copy = $source.Value | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $copy.quant = $Quant; $copy.displayName = "$($source.Value.displayName) ($Quant)"; $copy.PSObject.Properties.Remove('file'); $copy.PSObject.Properties.Remove('sizeBytes'); $copy.PSObject.Properties.Remove('sha256')
        $config.profiles | Add-Member -NotePropertyName $variant -NotePropertyValue $copy
        Write-Profiles $config
    }
    Write-Host "Created quant variant '$variant'. Run: .\harness.ps1 init"
}

function Run-Experiment {
    if ($Profile -eq "compare") {
        & node (Join-Path $Root "scripts\experiment.mjs") compare $RuntimeDir $Value $Extra
    } else {
        $name = if ($Value) { $Value } else { "routing" }
        & node (Join-Path $Root "scripts\experiment.mjs") record $RuntimeDir $name
    }
    if ($LASTEXITCODE -ne 0) { throw "Experiment command failed." }
}

function Update-ModelCatalogue {
    $profiles = (Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json).profiles
    $repos = @($profiles.PSObject.Properties | ForEach-Object { $_.Value.repo } | Where-Object { $_ } | Sort-Object -Unique)
    if (-not $repos.Count) { Write-Host "No upstream GGUF repositories are configured."; return }
    & node (Join-Path $Root "scripts\model-catalogue.mjs") (Join-Path $RuntimeDir "model-catalogue.json") @repos
    if ($LASTEXITCODE -ne 0) { throw "Model catalogue update failed." }
    Write-Host "Upstream model catalogue refreshed in $RuntimeDir."
}

function Find-UpstreamCodingModels {
    & node (Join-Path $Root "scripts\model-discovery.mjs") (Join-Path $RuntimeDir "model-discovery.json")
    if ($LASTEXITCODE -ne 0) { throw "Upstream model discovery failed." }
    Write-Host "Ranked discovery candidates saved in $RuntimeDir; review before onboarding."
}

function Test-AdapterConformance {
    & node (Join-Path $Root "scripts\adapter-conformance.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Adapter conformance failed." }
}

function Update-Readiness {
    $output = Join-Path $RuntimeDir "readiness.json"
    $null = & node (Join-Path $Root "scripts\readiness.mjs") $Root $ModelsDir $RuntimeDir $output
    if ($LASTEXITCODE -ne 0) { throw "Readiness report generation failed." }
    return $output
}

function Improve-Coordinator {
    $script:Value = "full"; Run-RoutingEvals
    Train-Coordinator
    Evaluate-Coordinator
}

function Invoke-CoordinatorAutopilot {
    $mode = if ($Profile) { $Profile.ToLowerInvariant() } else { "once" }
    $statePath = Join-Path $RuntimeDir "coordinator-autopilot-daemon.json"
    $taskName = "ChapekNineCoordinatorAutopilot"
    if ($mode -eq "install") {
        $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
        $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'harness.ps1')`" coordinator-autopilot start"
        $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "Starts the local Chapek Nine coordinator autopilot after user logon." -Force | Out-Null
        Write-Host "Installed per-user coordinator autopilot scheduled task '$taskName'."; return
    }
    if ($mode -eq "uninstall") {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Removed coordinator autopilot scheduled task '$taskName'."; return
    }
    if ($mode -eq "start") {
        $existing = Get-Content -Raw -LiteralPath $statePath -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        $process = if ($existing) { Get-Process -Id $existing.pid -ErrorAction SilentlyContinue } else { $null }
        if ($process -and $process.ProcessName -in @("powershell", "pwsh")) { Write-Host "Coordinator autopilot already runs as PID $($process.Id)."; return }
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
        $process = Start-Process -FilePath $powershell -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $Root "harness.ps1"), "coordinator-autopilot", "watch") -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $LogDir "coordinator-autopilot.out.log") -RedirectStandardError (Join-Path $LogDir "coordinator-autopilot.err.log") -PassThru -WindowStyle Hidden
        Write-Utf8NoBom $statePath (([ordered]@{ pid = $process.Id; started = (Get-Date).ToUniversalTime().ToString("o"); outputLog = (Join-Path $LogDir "coordinator-autopilot.out.log"); errorLog = (Join-Path $LogDir "coordinator-autopilot.err.log") } | ConvertTo-Json) + "`n")
        Write-Host "Started coordinator autopilot daemon (PID $($process.Id))."; return
    }
    if ($mode -eq "stop") {
        $existing = Get-Content -Raw -LiteralPath $statePath -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        $process = if ($existing) { Get-Process -Id $existing.pid -ErrorAction SilentlyContinue } else { $null }
        if ($process -and $process.ProcessName -in @("powershell", "pwsh")) { Stop-Process -Id $process.Id; Write-Host "Stopped coordinator autopilot daemon." }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue; return
    }
    if ($mode -eq "status") { Get-Content -Raw -LiteralPath $statePath -ErrorAction SilentlyContinue; return }
    if ($mode -notin @("once", "watch")) { throw "Usage: .\harness.ps1 coordinator-autopilot [once|watch|start|stop|status|install|uninstall]" }
    $watch = $mode -eq "watch"
    # `watch` is a command mode, never a worker profile. Clear it before the
    # improvement flow starts the normal selected worker/router.
    $script:Profile = $null
    do {
        $raw = & node (Join-Path $Root "scripts\coordinator-autopilot.mjs") $RuntimeDir check
        if ($LASTEXITCODE -ne 0) { throw "Coordinator autopilot check failed." }
        $next = $raw | ConvertFrom-Json
        Write-Host "Coordinator autopilot: $($next.action) ($($next.reason))"
        if ($next.action -eq "improve") {
            Improve-Coordinator
            $evaluation = Get-Content -Raw -LiteralPath (Join-Path $RuntimeDir "coordinator-eval.json") | ConvertFrom-Json
            $accepted = ([string]$evaluation.promotion.accepted).ToLowerInvariant()
            & node (Join-Path $Root "scripts\coordinator-autopilot.mjs") $RuntimeDir record $accepted
            if ($LASTEXITCODE -ne 0) { throw "Coordinator autopilot state update failed." }
        }
        if ($watch) { Start-Sleep -Seconds 900 }
    } while ($watch)
}

function Start-BackgroundDownload {
    $selected = Get-SelectedProfile
    Assert-ProfileCapacity $selected
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node is required for verified model downloads." }

    New-Item -ItemType Directory -Force -Path $LogDir, $DownloadJobsDir | Out-Null
    $jobPath = Join-Path $DownloadJobsDir "$($selected.Name).json"
    if (Test-Path -LiteralPath $jobPath) {
        try {
            $previous = Get-Content -Raw -LiteralPath $jobPath | ConvertFrom-Json
            $previousProcess = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
            if ($previousProcess -and $previousProcess.ProcessName -in @("powershell", "pwsh")) {
                Write-Host "Background download for '$($selected.Name)' is already running (PID $($previous.pid)). Log: $($previous.outputLog)"
                return
            }
        } catch {
            Write-Warning "Replacing unreadable background download state '$jobPath'."
        }
    }

    $outputLog = Join-Path $LogDir "download-$($selected.Name).out.log"
    $errorLog = Join-Path $LogDir "download-$($selected.Name).err.log"
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $Root "harness.ps1"), "download", $selected.Name
    )
    $process = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $Root `
        -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
    $state = [ordered]@{
        profile = $selected.Name
        pid = $process.Id
        started = (Get-Date).ToUniversalTime().ToString("o")
        outputLog = $outputLog
        errorLog = $errorLog
    }
    Write-Utf8NoBom $jobPath (($state | ConvertTo-Json) + "`n")
    Write-Host "Started background download for '$($selected.Name)' (PID $($process.Id))."
    Write-Host "Follow progress: Get-Content -Wait -LiteralPath '$outputLog'"
}

function Read-CoordinatorConfig {
    Get-Content -Raw -LiteralPath $CoordinatorConfigPath | ConvertFrom-Json
}

function Get-CoordinatorBaseModel {
    $directory = Join-Path $ModelsDir "coordinator"
    $manifestPath = Join-Path $directory "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
    try {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
        $config = Read-CoordinatorConfig
        if ($manifest.repo -ne $config.base.repo -or $manifest.quant -ne $config.base.quant) {
            return $null
        }
        $file = Join-Path $directory $manifest.files[0].path
        if (
            (Test-Path -LiteralPath $file) -and
            (Get-Item -LiteralPath $file).Length -eq [int64]$config.base.sizeBytes
        ) {
            return $file
        }
    } catch {}
    return $null
}

function Download-Coordinator {
    $config = Read-CoordinatorConfig
    $directory = Join-Path $ModelsDir "coordinator"
    Write-Host "Downloading the small CPU-resident Chapek Nine coordinator base..."
    & node (Join-Path $Root "scripts\download-hf.mjs") $config.base.repo $config.base.quant $directory
    if ($LASTEXITCODE -ne 0) { throw "Coordinator base download failed with exit code $LASTEXITCODE." }
    $model = Get-CoordinatorBaseModel
    if (-not $model) { throw "Coordinator base manifest did not validate after download." }
    return $model
}

function Find-TrainingPython {
    if ($env:CHAPEK_PYTHON -and (Test-Path -LiteralPath $env:CHAPEK_PYTHON)) {
        $override = (Resolve-Path -LiteralPath $env:CHAPEK_PYTHON).Path
        $overrideVersion = & $override -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)" 2>$null
        if ($overrideVersion -notmatch "^\d+$" -or [int]$overrideVersion -lt 310 -or [int]$overrideVersion -gt 312) {
            throw "CHAPEK_PYTHON must be Python 3.10-3.12 for Windows CUDA QLoRA; got '$overrideVersion'."
        }
        return $override
    }
    $paths = @()
    foreach ($candidate in @("python", "python3")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { $paths += $command.Source }
    }
    # The python.org Windows installer is not necessarily registered with
    # py.exe (and pyenv shims may exist without a selected version). Discover
    # the standard per-user installation that is already on the machine.
    $userPythonRoot = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "Programs\Python"
    } else { $null }
    if ($userPythonRoot -and (Test-Path -LiteralPath $userPythonRoot)) {
        $paths += Get-ChildItem -LiteralPath $userPythonRoot -Directory -Filter "Python*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "python.exe" }
    }
    foreach ($candidate in ($paths | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $version = & $candidate -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)" 2>$null
        # Current Windows CUDA PyTorch wheels support Python through 3.12.
        # Prefer a supported interpreter over a newer CPU-only wheel.
        if ($version -match "^\d+$" -and [int]$version -ge 310 -and [int]$version -le 312) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "Python 3.10-3.12 was not found. Install one or set CHAPEK_PYTHON to its python.exe path for Windows CUDA QLoRA."
}

function Train-Coordinator {
    $python = Find-TrainingPython
    $coordinatorDir = Join-Path $RuntimeDir "coordinator"
    $dataDir = Join-Path $coordinatorDir "data"
    $venvDir = Join-Path $coordinatorDir "venv"
    $adapterDir = Join-Path $coordinatorDir "lora-hf"
    $adapterGguf = Join-Path $coordinatorDir "chapek-nine-lora.gguf"
    New-Item -ItemType Directory -Force -Path $coordinatorDir | Out-Null
    & node (Join-Path $Root "scripts\generate-coordinator-data.mjs") $dataDir `
        (Join-Path $RuntimeDir "routing-evals.json")
    if ($LASTEXITCODE -ne 0) { throw "Coordinator dataset generation failed." }
    $venvPython = Join-Path $venvDir "Scripts\python.exe"
    $requestedVersion = & $python -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)"
    $venvVersion = if (Test-Path -LiteralPath $venvPython) {
        & $venvPython -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)" 2>$null
    } else { $null }
    if ($venvVersion -and $venvVersion -ne $requestedVersion) {
        Write-Host "Replacing coordinator venv built for Python $venvVersion with Python $requestedVersion."
        Remove-Item -LiteralPath $venvDir -Recurse -Force
    }
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $python -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw "Could not create coordinator training venv." }
    }
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r (Join-Path $Root "training\requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Coordinator training dependencies failed to install." }
    $torchIndex = if ($env:CHAPEK_TORCH_INDEX_URL) { $env:CHAPEK_TORCH_INDEX_URL } else { "https://download.pytorch.org/whl/cu126" }
    Write-Host "Installing CUDA-enabled PyTorch for QLoRA from $torchIndex"
    & $venvPython -m pip install --upgrade --force-reinstall --no-cache-dir torch --index-url $torchIndex
    if ($LASTEXITCODE -ne 0) { throw "Could not install CUDA-enabled PyTorch. Set CHAPEK_TORCH_INDEX_URL to a compatible official PyTorch wheel index." }
    & $venvPython -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable'; print('QLoRA CUDA:', torch.version.cuda, torch.cuda.get_device_name(0))"
    if ($LASTEXITCODE -ne 0) { throw "CUDA-enabled PyTorch is unavailable after installation; QLoRA cannot run." }
    $coordinatorConfig = Read-CoordinatorConfig
    & $venvPython (Join-Path $Root "training\train_coordinator.py") `
        --base-model $coordinatorConfig.trainingBase --data-dir $dataDir `
        --output-dir $adapterDir --qlora
    if ($LASTEXITCODE -ne 0) { throw "Coordinator LoRA training failed." }
    $llamaSource = Join-Path $RuntimeDir "llama.cpp-source"
    if (-not (Test-Path -LiteralPath (Join-Path $llamaSource "convert_lora_to_gguf.py"))) {
        & git clone --depth 1 https://github.com/ggml-org/llama.cpp.git $llamaSource
        if ($LASTEXITCODE -ne 0) { throw "Could not obtain llama.cpp adapter converter." }
    }
    & $venvPython -m pip install (Join-Path $llamaSource "gguf-py")
    & $venvPython (Join-Path $llamaSource "convert_lora_to_gguf.py") `
        --outfile $adapterGguf --outtype f16 $adapterDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $adapterGguf)) {
        throw "LoRA-to-GGUF conversion failed."
    }
    Write-Host "Chapek Nine coordinator adapter trained at $adapterGguf"
}

function Get-InferenceArgs($Selected, [string]$ModelPath) {
    $context = Get-EffectiveValue $Selected "context" 4096
    $batchSize = Get-EffectiveValue $Selected "batchSize" 512
    $ubatchSize = Get-EffectiveValue $Selected "ubatchSize" 256
    $threads = Get-EffectiveValue $Selected "threads" ([math]::Max(1, [Environment]::ProcessorCount / 2))
    $flashAttention = Get-EffectiveValue $Selected "flashAttention" $true
    $verificationTokens = Get-EffectiveValue $Selected "verificationTokens" 12
    $verificationReasoning = Get-EffectiveValue $Selected "verificationReasoning" $null
    $args = @(
        "-m", $ModelPath,
        "--jinja",
        "--ctx-size", "$context",
        "--flash-attn", $(if ($flashAttention) { "on" } else { "off" }),
        "--batch-size", "$batchSize",
        "--ubatch-size", "$ubatchSize",
        "--threads", "$threads",
        "--parallel", "1",
        "--prompt", "Reply with exactly: LOCAL CUDA OK",
        "--predict", "$verificationTokens",
        "--single-turn",
        "--no-display-prompt"
    )
    $args += Get-CacheArgs $Selected
    $args += Get-OffloadArgs $Selected
    if ($verificationReasoning) { $args += @("--reasoning", "$verificationReasoning") }
    return $args
}

function Get-CacheArgs($Selected) {
    $cacheTypeK = Get-EffectiveValue $Selected "cacheTypeK" $(if ($Selected.Config.cacheTypeK) { $Selected.Config.cacheTypeK } else { "q8_0" })
    $cacheTypeV = Get-EffectiveValue $Selected "cacheTypeV" $(if ($Selected.Config.cacheTypeV) { $Selected.Config.cacheTypeV } else { "q8_0" })
    return @("--cache-type-k", $cacheTypeK, "--cache-type-v", $cacheTypeV)
}

function Get-OffloadArgs($Selected, [bool]$AllowEnvironmentOverride = $true) {
    $mode = if ($AllowEnvironmentOverride -and $env:KIMI_OFFLOAD_MODE) {
        $env:KIMI_OFFLOAD_MODE
    } else {
        Get-EffectiveValue $Selected "offloadMode" $Selected.Config.offloadMode
    }
    switch ($mode) {
        "auto" {
            # Current llama.cpp fit logic is MoE-aware. Do not combine it with
            # explicit -ngl/-ot flags: those disable automatic memory fitting.
            $fitTarget = Get-EffectiveValue $Selected "fitTargetMiB" 1536
            return @("--fit", "on", "--fit-target", "$fitTarget")
        }
        "cpu-moe" {
            if (-not $Selected.Config.hybridMoe) { throw "cpu-moe is only valid for a sparse MoE profile." }
            return @("--fit", "off", "-ngl", "all", "--cpu-moe")
        }
        "partial-cpu-moe" {
            if (-not $Selected.Config.hybridMoe) { throw "partial-cpu-moe is only valid for a sparse MoE profile." }
            $cpuMoeLayers = if ($AllowEnvironmentOverride -and $env:KIMI_N_CPU_MOE) {
                $env:KIMI_N_CPU_MOE
            } else {
                "$(Get-EffectiveValue $Selected "cpuMoeLayers" $Selected.Config.cpuMoeLayers)"
            }
            if ($null -eq $cpuMoeLayers -or $cpuMoeLayers -notmatch "^\d+$") {
                throw "Set cpuMoeLayers in the profile or KIMI_N_CPU_MOE to a non-negative layer count."
            }
            return @("--fit", "off", "-ngl", "all", "--n-cpu-moe", $cpuMoeLayers)
        }
        default {
            throw "Unknown offload mode '$mode'. Use auto, cpu-moe, or partial-cpu-moe."
        }
    }
}

function Write-LlamaPresets {
    $config = Read-Profiles
    $activeProfileName = (Get-SelectedProfile).Name
    $lines = @(
        "version = 1",
        "",
        "[*]",
        "jinja = true",
        "parallel = 1",
        "batch-size = 512",
        "ubatch-size = 256",
        "cache-prompt = true",
        "cache-ram = 512",
        "ctx-checkpoints = 8",
        "checkpoint-min-step = 256",
        "slot-save-path = $KvCacheDir",
        ""
    )
    $readyProfiles = @()
    foreach ($entry in $config.profiles.PSObject.Properties) {
        if (-not $entry.Value.supported) { continue }
        $selected = [pscustomobject]@{ Name = $entry.Name; Config = $entry.Value }
        $localModel = Get-LocalModel $selected
        if (-not $localModel) { continue }
        $readyProfiles += $selected.Name
        $context = Get-EffectiveValue $selected "context" 4096
        $batchSize = Get-EffectiveValue $selected "batchSize" 512
        $ubatchSize = Get-EffectiveValue $selected "ubatchSize" 256
        $lines += "[$($selected.Name)]"
        $lines += "model = $($localModel.ModelPath)"
        $lines += "ctx-size = $context"
        $lines += "batch-size = $batchSize"
        $lines += "ubatch-size = $ubatchSize"
        $lines += "cache-type-k = $(Get-EffectiveValue $selected 'cacheTypeK' $(if ($selected.Config.cacheTypeK) { $selected.Config.cacheTypeK } else { 'q8_0' }))"
        $lines += "cache-type-v = $(Get-EffectiveValue $selected 'cacheTypeV' $(if ($selected.Config.cacheTypeV) { $selected.Config.cacheTypeV } else { 'q8_0' }))"
        $flashAttention = Get-EffectiveValue $selected "flashAttention" $true
        $lines += "flash-attn = $(if ($flashAttention) { 'on' } else { 'off' })"
        $lines += "threads = $(Get-EffectiveValue $selected 'threads' ([math]::Max(1, [Environment]::ProcessorCount / 2)))"
        $offloadArgs = Get-OffloadArgs $selected ($selected.Name -eq $activeProfileName)
        for ($index = 0; $index -lt $offloadArgs.Count; $index += 1) {
            $key = $offloadArgs[$index] -replace "^-+", ""
            if ($key -eq "ngl") { $key = "n-gpu-layers" }
            $hasValue = (
                $index + 1 -lt $offloadArgs.Count -and
                $offloadArgs[$index + 1] -notmatch "^-"
            )
            if ($hasValue) {
                $lines += "$key = $($offloadArgs[$index + 1])"
                $index += 1
            } else {
                $lines += "$key = true"
            }
        }
        $lines += "load-on-startup = false"
        $lines += "stop-timeout = 30"
        $lines += ""
    }
    if ($readyProfiles.Count -eq 0) {
        throw "No downloaded model is available for the llama.cpp router."
    }
    New-Item -ItemType Directory -Force -Path $RuntimeDir, $KvCacheDir | Out-Null
    $presetPath = Join-Path $RuntimeDir "models.ini"
    $content = ($lines -join "`r`n") + "`r`n"
    Write-Utf8NoBom $presetPath $content
    [pscustomobject]@{
        Path = $presetPath
        Content = $content
        Profiles = $readyProfiles
    }
}

function Get-StringHash([string]$Content) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Content)
        return [Convert]::ToBase64String($sha.ComputeHash($bytes))
    } finally {
        $sha.Dispose()
    }
}

function Get-LlamaApiHeaders {
    # llama.cpp honours LLAMA_API_KEY when it is present in the environment.
    # Keep router-management calls authenticated too, otherwise a server can
    # be healthy but reject the first /models/load request.
    if ($env:LLAMA_API_KEY) {
        return @{ Authorization = "Bearer $($env:LLAMA_API_KEY)" }
    }
    return @{}
}

function Set-RouterModel([string]$ModelId) {
    $headers = Get-LlamaApiHeaders
    $catalog = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/models?reload=1" -Headers $headers -TimeoutSec 30
    foreach ($model in @($catalog.data)) {
        if (
            $model.id -ne $ModelId -and
            $model.status.value -in @("loaded", "loading", "sleeping")
        ) {
            $unloadBody = @{ model = $model.id } | ConvertTo-Json
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/models/unload" -Method Post `
                -Headers $headers -ContentType "application/json" -Body $unloadBody -TimeoutSec 180
        }
    }
    $body = @{ model = $ModelId } | ConvertTo-Json
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/models/load" -Method Post `
        -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 1200
}

function Verify-Profile {
    $selected = Get-SelectedProfile
    Assert-ProfileCapacity $selected
    $cli = Find-LlamaCli
    if (-not $cli) { throw "llama-cli is not installed. Run: .\harness.ps1 setup" }
    $devices = & $cli --list-devices 2>&1
    if (($devices -join "`n") -notmatch "CUDA") { throw "This llama.cpp build does not expose a CUDA device." }
    $localModel = Get-LocalModel $selected
    if (-not $localModel) {
        Download-Profile
        $localModel = Get-LocalModel $selected
    }
    if (-not $localModel) { throw "The verified model manifest is missing after download." }
    Write-Host "CUDA device detected. Running local inference verification..."
    $args = Get-InferenceArgs $selected $localModel.ModelPath
    $output = @(& $cli @args 2>&1)
    $exitCode = $LASTEXITCODE
    $text = $output -join "`n"
    $output | ForEach-Object { Write-Host $_ }
    $promptTps = if ($text -match "Prompt:\s*([0-9.]+)\s*t/s") { [double]$Matches[1] } else { $null }
    $generationTps = if ($text -match "Generation:\s*([0-9.]+)\s*t/s") { [double]$Matches[1] } else { $null }
    $passed = $exitCode -eq 0 -and $text -match "(?m)^\s*LOCAL CUDA OK\s*$"
    $reportDir = Join-Path $RuntimeDir "verification"
    New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    $report = [ordered]@{
        version = 1
        profile = $selected.Name
        modelPath = $localModel.ModelPath
        verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
        cuda = $true
        passed = $passed
        exitCode = $exitCode
        promptTps = $promptTps
        generationTps = $generationTps
        expected = "LOCAL CUDA OK"
        outputTail = $text.Substring([math]::Max(0, $text.Length - 4000))
    }
    Write-Utf8NoBom (Join-Path $reportDir "$($selected.Name).json") (($report | ConvertTo-Json -Depth 4) + "`n")
    if ($exitCode -ne 0) { throw "Local CUDA inference failed with exit code $exitCode." }
    if (-not $passed) { throw "Local CUDA inference completed but did not return the required exact verification token. See runtime\verification\$($selected.Name).json." }
    Write-Host "Local inference verification passed."
}

function Verify-AllProfiles {
    $config = Read-Profiles
    $savedProfile = $script:Profile
    $results = @()
    try {
        foreach ($property in $config.profiles.PSObject.Properties) {
            $name = $property.Name; $entry = $property.Value
            if (-not $entry.supported) { $results += [pscustomobject]@{ profile = $name; status = "skipped"; reason = "capability-gated" }; continue }
            $selected = [pscustomobject]@{ Name = $name; Config = $entry }
            if (-not (Get-LocalModel $selected)) { $results += [pscustomobject]@{ profile = $name; status = "skipped"; reason = "not downloaded" }; continue }
            $script:Profile = $name
            try { Verify-Profile; $results += [pscustomobject]@{ profile = $name; status = "passed"; reason = $null } }
            catch { Write-Warning "Verification failed for '$name': $($_.Exception.Message)"; $results += [pscustomobject]@{ profile = $name; status = "failed"; reason = $_.Exception.Message } }
        }
    } finally { $script:Profile = $savedProfile }
    $results | Format-Table -AutoSize | Out-Host
    $failed = @($results | Where-Object { $_.status -eq "failed" }).Count
    if ($failed) { throw "$failed model verification(s) failed; see runtime\verification." }
}

function Calibrate-Profile {
    $selected = Get-SelectedProfile
    Assert-ProfileCapacity $selected
    $bench = Find-LlamaBench
    if (-not $bench) { throw "llama-bench is not installed. Run: .\harness.ps1 setup" }
    $localModel = Get-LocalModel $selected
    if (-not $localModel) {
        Download-Profile
        $localModel = Get-LocalModel $selected
    }
    if (-not $localModel) { throw "Profile '$($selected.Name)' has no verified local model." }
    $calibrationMode = if ($Value) { $Value.ToLowerInvariant() } else { "quick" }
    if ($calibrationMode -notin @("quick", "full")) {
        throw "Calibration mode must be 'quick' or 'full'."
    }
    if (Test-Path -LiteralPath $StatePath) {
        Write-Host "Stopping the managed router so calibration has exclusive access to RAM and VRAM."
        Stop-Server
    }
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Write-Host "Calibrating $($selected.Name) in $calibrationMode mode. Unsafe candidates will be terminated."
    & node (Join-Path $Root "scripts\calibrate.mjs") $bench $localModel.ModelPath `
        $selected.Name $ConfigPath $CalibrationPath $calibrationMode
    if ($LASTEXITCODE -ne 0) { throw "Calibration failed with exit code $LASTEXITCODE." }
    Write-Host "Calibration saved to $CalibrationPath and will be applied automatically."
}

function Calibrate-AllProfiles {
    $calibrationMode = if ($Value) { $Value.ToLowerInvariant() } else { "full" }
    if ($calibrationMode -notin @("quick", "full")) { throw "Calibration mode must be 'quick' or 'full'." }
    $config = Read-Profiles
    $savedProfile = $script:Profile
    $savedValue = $script:Value
    $results = @()
    try {
        foreach ($property in $config.profiles.PSObject.Properties) {
            $name = $property.Name
            $entry = $property.Value
            if (-not $entry.supported) { continue }
            $selected = [pscustomobject]@{ Name = $name; Config = $entry }
            if (-not (Get-LocalModel $selected)) {
                $results += [pscustomobject]@{ profile = $name; status = "skipped"; reason = "not downloaded" }
                continue
            }
            $script:Profile = $name
            $script:Value = $calibrationMode
            try {
                Calibrate-Profile
                $results += [pscustomobject]@{ profile = $name; status = "calibrated"; reason = $null }
            } catch {
                Write-Warning "Calibration failed for '$name': $($_.Exception.Message)"
                $results += [pscustomobject]@{ profile = $name; status = "failed"; reason = $_.Exception.Message }
            }
        }
    } finally {
        $script:Profile = $savedProfile
        $script:Value = $savedValue
    }
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Write-Utf8NoBom (Join-Path $RuntimeDir "calibration-all.json") (($results | ConvertTo-Json -Depth 4) + "`n")
    $results | Format-Table -AutoSize | Out-Host
    $failed = @($results | Where-Object { $_.status -eq "failed" }).Count
    if ($failed) { throw "$failed model calibration(s) failed; see runtime\calibration-all.json." }
    Start-Server
}

function Initialize-AllModels {
    Install-Harness
    # A catalogue refresh is advisory: discovery failures are recorded in the
    # runtime report and never prevent an already-configured local setup.
    Update-ModelCatalogue
    Find-UpstreamCodingModels
    $config = Read-Profiles
    $savedProfile = $script:Profile
    $savedValue = $script:Value
    try {
        foreach ($property in $config.profiles.PSObject.Properties) {
            $name = $property.Name
            $entry = $property.Value
            if (-not $entry.supported) { continue }
            $selected = [pscustomobject]@{ Name = $name; Config = $entry }
            if (-not (Get-LocalModel $selected)) {
                Write-Host "Downloading practical worker '$name'..."
                $script:Profile = $name
                Download-Profile
            }
        }
        $script:Profile = $null
        Verify-AllProfiles
        $script:Profile = $null
        $script:Value = "full"
        Calibrate-AllProfiles
        foreach ($property in $config.profiles.PSObject.Properties) {
            $name = $property.Name
            $entry = $property.Value
            if (-not $entry.supported) { continue }
            $selected = [pscustomobject]@{ Name = $name; Config = $entry }
            if (Get-LocalModel $selected) {
                $script:Profile = $name
                Probe-Profile
            }
        }
        Update-Readiness | Out-Null
    } finally {
        $script:Profile = $savedProfile
        $script:Value = $savedValue
    }
    $coordinatorConfig = Read-CoordinatorConfig
    $adapter = Join-Path $RuntimeDir $coordinatorConfig.adapter
    $mustTrain = -not (Test-Path -LiteralPath $adapter)
    Test-AdapterConformance
    $script:Value = "full"
    Run-RoutingEvals
    Run-Experiment
    if ($mustTrain) {
        Train-Coordinator
    }
    Start-Server
    Evaluate-Coordinator
    Write-Host "Chapek Nine is initialized, measured, and running. Launch Pi with: .\harness.ps1 pi"
}

function Show-CalibrationStatus {
    $selected = Get-SelectedProfile
    if (-not (Test-Path -LiteralPath $CalibrationPath)) { throw "No calibration exists. Run: .\harness.ps1 calibrate $($selected.Name) full" }
    & node (Join-Path $Root "scripts\calibration-regression.mjs") $CalibrationPath $selected.Name
    if ($LASTEXITCODE -eq 2) { Write-Warning "Throughput regression exceeds the configured threshold; rerun full calibration before long sessions." }
    elseif ($LASTEXITCODE -ne 0) { throw "Could not assess calibration regression." }
}

function Probe-Profile {
    Start-Server
    $selected = Get-SelectedProfile
    $local = Get-LocalModel $selected
    if (-not $local) { throw "Profile '$($selected.Name)' is not downloaded." }
    $env:LLAMA_BASE_URL = "http://127.0.0.1:$Port"
    & node (Join-Path $Root "scripts\probe-model.mjs") $local.ModelId (Join-Path $RuntimeDir "capabilities\$($selected.Name).json")
    if ($LASTEXITCODE -ne 0) { throw "Model capability probe failed." }
}

function Evaluate-Coordinator {
    Start-Server
    $dataDir = Join-Path $RuntimeDir "coordinator\data"
    if (-not (Test-Path -LiteralPath (Join-Path $dataDir "validation.jsonl"))) {
        throw "Coordinator validation data is missing. Run: .\harness.ps1 train-coordinator"
    }
    $env:CHAPEK_COORDINATOR_URL = "http://127.0.0.1:$CoordinatorPort"
    & node (Join-Path $Root "scripts\evaluate-coordinator.mjs") $dataDir (Join-Path $RuntimeDir "coordinator-eval.json")
    if ($LASTEXITCODE -eq 2) { Write-Warning "Coordinator did not meet promotion thresholds; keep deterministic routing active." }
    elseif ($LASTEXITCODE -ne 0) { throw "Coordinator evaluation failed." }
}

function Bootstrap-Harness {
    Install-Harness
    Verify-Profile
    $selected = Get-SelectedProfile
    if (-not (Get-CalibratedSettings $selected)) {
        Calibrate-Profile
    }
    if (-not (Get-CoordinatorBaseModel)) {
        $null = Download-Coordinator
    }
    $coordinatorConfig = Read-CoordinatorConfig
    $coordinatorAdapter = Join-Path $RuntimeDir $coordinatorConfig.adapter
    if (-not (Test-Path -LiteralPath $coordinatorAdapter)) {
        Train-Coordinator
    }
    Test-PiProfile
    Write-Host "Bootstrap complete. Launch Pi with: .\harness.ps1 pi $($selected.Name)"
}

function Start-Server {
    $selected = Get-SelectedProfile
    Assert-ProfileCapacity $selected
    $server = Find-LlamaServer
    if (-not $server) { throw "llama.cpp is not installed. Run: .\harness.ps1 setup" }
    $localModel = Get-LocalModel $selected
    if (-not $localModel) {
        Download-Profile
        $localModel = Get-LocalModel $selected
    }
    if (-not $localModel) { throw "Profile '$($selected.Name)' has no verified local model after download." }
    $presets = Write-LlamaPresets
    $runtimeSignature = Get-StringHash $presets.Content
    $existing = Get-Content -Raw -LiteralPath $StatePath -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
    $existingProcess = if ($existing) { Get-Process -Id $existing.pid -ErrorAction SilentlyContinue } else { $null }
    if ($existingProcess -and $existingProcess.ProcessName -notlike "llama-server*") {
        Write-Warning "Ignoring stale router state because PID $($existing.pid) belongs to $($existingProcess.ProcessName)."
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        $existingProcess = $null
    }
    if ($existingProcess -and $existing.runtime -ne $runtimeSignature) {
        Write-Host "Model catalog or per-model runtime settings changed; restarting the managed router."
        Stop-Process -Id $existing.pid -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        $existingProcess = $null
    }
    if ($existingProcess) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            Set-RouterModel $localModel.ModelId
            $existing.profile = $selected.Name
            $existing | Add-Member -NotePropertyName runtime -NotePropertyValue $runtimeSignature -Force
            $existing | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
            Start-Coordinator $existing
            Start-ModelProxy $existing
            Write-Host "llama.cpp router ready with $($localModel.ModelId) (PID $($existing.pid))."
            return
        } catch {
            Write-Warning "Recorded router is not usable; restarting it."
            Stop-Process -Id $existing.pid -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        }
    }
    $args = @(
        "--models-dir", $ModelsDir,
        "--models-preset", $presets.Path,
        "--no-models-autoload",
        "--jinja",
        "--host", "127.0.0.1",
        "--port", "$Port"
    )
    $process = Start-Process -FilePath $server -ArgumentList $args -RedirectStandardOutput $ServerLog -RedirectStandardError "$ServerLog.err" -PassThru -WindowStyle Hidden
    [pscustomobject]@{
        pid = $process.Id
        port = $Port
        profile = $selected.Name
        runtime = $runtimeSignature
        started = (Get-Date).ToString("o")
    } |
        ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        throw "llama-server exited. See $ServerLog.err"
    }
    $ready = $false
    foreach ($attempt in 1..30) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            $ready = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $ready) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        throw "llama.cpp router did not become healthy. See $ServerLog.err"
    }
    $modelId = $localModel.ModelId
    Write-Host "Router is healthy. Loading $modelId..."
    try {
        Set-RouterModel $modelId
    } catch {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        throw "Model load failed. Run '.\harness.ps1 download $($selected.Name)' first. $($_.Exception.Message)"
    }
    $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    Start-Coordinator $state
    Start-ModelProxy $state
    Write-Host "llama.cpp router ready on http://127.0.0.1:$Port (PID $($process.Id))."
}

function Start-Coordinator($State) {
    $config = Read-CoordinatorConfig
    $adapter = Join-Path $RuntimeDir $config.adapter
    if (-not (Test-Path -LiteralPath $adapter)) {
        $State | Add-Member -NotePropertyName coordinatorEnabled -NotePropertyValue $false -Force
        $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
        Write-Warning "Coordinator adapter is not trained; Chapek Nine will use its deterministic safety policy. Run: .\harness.ps1 train-coordinator"
        return
    }
    $base = Get-CoordinatorBaseModel
    if (-not $base) { $base = Download-Coordinator }
    $process = if ($State.coordinatorPid) { Get-Process -Id $State.coordinatorPid -ErrorAction SilentlyContinue } else { $null }
    if ($process -and $process.ProcessName -notlike "llama-server*") {
        Write-Warning "Ignoring stale coordinator PID $($State.coordinatorPid) owned by $($process.ProcessName)."
        $process = $null
    }
    if ($process) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$CoordinatorPort/health" -TimeoutSec 3
            $State | Add-Member -NotePropertyName coordinatorEnabled -NotePropertyValue $true -Force
            $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
            return
        } catch {
            Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        }
    }
    $server = Find-LlamaServer
    $args = @(
        "--model", $base,
        "--lora", $adapter,
        "--alias", $config.modelId,
        "--device", "none",
        "--gpu-layers", "0",
        "--no-kv-offload",
        "--ctx-size", "$($config.context)",
        "--parallel", "1",
        "--jinja",
        "--host", "127.0.0.1",
        "--port", "$CoordinatorPort"
    )
    $process = Start-Process -FilePath $server -ArgumentList $args `
        -RedirectStandardOutput $CoordinatorLog -RedirectStandardError "$CoordinatorLog.err" `
        -PassThru -WindowStyle Hidden
    $State | Add-Member -NotePropertyName coordinatorPid -NotePropertyValue $process.Id -Force
    $State | Add-Member -NotePropertyName coordinatorEnabled -NotePropertyValue $true -Force
    $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
    foreach ($attempt in 1..60) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$CoordinatorPort/health" -TimeoutSec 2
            Write-Host "CPU-only LoRA coordinator ready on http://127.0.0.1:$CoordinatorPort (PID $($process.Id))."
            return
        } catch {
            if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
                throw "Coordinator exited. See $CoordinatorLog.err"
            }
            Start-Sleep -Seconds 1
        }
    }
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    throw "Coordinator did not become healthy. See $CoordinatorLog.err"
}

function Start-ModelProxy($State) {
    $proxyScript = Join-Path $Root "scripts\model-proxy.mjs"
    if (-not (Test-Path -LiteralPath $proxyScript)) { throw "Missing transparent proxy: $proxyScript" }
    $proxyProcess = if ($State.proxyPid) { Get-Process -Id $State.proxyPid -ErrorAction SilentlyContinue } else { $null }
    if ($proxyProcess -and $proxyProcess.ProcessName -notin @("node", "nodejs")) {
        Write-Warning "Ignoring stale proxy PID $($State.proxyPid) owned by $($proxyProcess.ProcessName)."
        $proxyProcess = $null
    }
    $expectedCoordinator = [bool]$State.coordinatorEnabled
    if ($proxyProcess -and [bool]$State.proxyCoordinatorEnabled -ne $expectedCoordinator) {
        Stop-Process -Id $proxyProcess.Id -ErrorAction SilentlyContinue
        $proxyProcess = $null
    }
    if ($proxyProcess) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/health" -TimeoutSec 5
            return
        } catch {
            Stop-Process -Id $proxyProcess.Id -ErrorAction SilentlyContinue
        }
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $previousBaseUrl = $env:LLAMA_BASE_URL
    $previousProxyPort = $env:KIMI_PROXY_PORT
    $previousKvCacheDir = $env:KIMI_KV_CACHE_DIR
    $previousCoordinatorUrl = $env:CHAPEK_COORDINATOR_URL
    $previousReadinessPath = $env:CHAPEK_READINESS_PATH
    try {
        $env:LLAMA_BASE_URL = "http://127.0.0.1:$Port"
        $env:KIMI_PROXY_PORT = "$ProxyPort"
        $env:KIMI_KV_CACHE_DIR = $KvCacheDir
        $env:CHAPEK_COORDINATOR_URL = if ($expectedCoordinator) {
            "http://127.0.0.1:$CoordinatorPort"
        } else { $null }
        $env:CHAPEK_READINESS_PATH = Update-Readiness
        $proxyProcess = Start-Process -FilePath $node -ArgumentList @($proxyScript) `
            -RedirectStandardOutput $ProxyLog -RedirectStandardError "$ProxyLog.err" `
            -PassThru -WindowStyle Hidden
    } finally {
        $env:LLAMA_BASE_URL = $previousBaseUrl
        $env:KIMI_PROXY_PORT = $previousProxyPort
        $env:KIMI_KV_CACHE_DIR = $previousKvCacheDir
        $env:CHAPEK_COORDINATOR_URL = $previousCoordinatorUrl
        $env:CHAPEK_READINESS_PATH = $previousReadinessPath
    }
    $State | Add-Member -NotePropertyName proxyPid -NotePropertyValue $proxyProcess.Id -Force
    $State | Add-Member -NotePropertyName proxyPort -NotePropertyValue $ProxyPort -Force
    $State | Add-Member -NotePropertyName proxyCoordinatorEnabled -NotePropertyValue $expectedCoordinator -Force
    $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
    foreach ($attempt in 1..30) {
        # Do this before probing the port. Otherwise an orphaned proxy from a
        # prior interrupted run can make a newly spawned process that failed
        # with EADDRINUSE look healthy.
        if (-not (Get-Process -Id $proxyProcess.Id -ErrorAction SilentlyContinue)) {
            throw "Model proxy exited before becoming healthy. See $ProxyLog.err"
        }
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/health" -TimeoutSec 2
            Write-Host "Transparent model front door ready on http://127.0.0.1:$ProxyPort (PID $($proxyProcess.Id))."
            return
        } catch {
            if (-not (Get-Process -Id $proxyProcess.Id -ErrorAction SilentlyContinue)) {
                throw "Model proxy exited. See $ProxyLog.err"
            }
            Start-Sleep -Seconds 1
        }
    }
    Stop-Process -Id $proxyProcess.Id -ErrorAction SilentlyContinue
    throw "Model proxy did not become healthy. See $ProxyLog.err"
}

function Write-PiLocalConfig($Selected, $LocalModel) {
    $piAgentDir = Join-Path $RuntimeDir "pi-agent"
    New-Item -ItemType Directory -Force -Path $piAgentDir | Out-Null
    $context = [int](Get-EffectiveValue $Selected "context" 4096)
    $maxTokens = [math]::Min(2048, $context)
    # pi-ai always subtracts a 4096-token provider safety allowance before it
    # computes max_tokens. Advertising the physical llama.cpp context directly
    # therefore clamps every <=4K local model to one output token. Add back
    # exactly that allowance: Pi's usable input+output budget remains $context,
    # so this does not overrun the real llama.cpp slot.
    $piContextWindow = $context + 4096
    $modelsConfig = @{
        providers = @{
            "llama-local" = @{
                baseUrl = "http://127.0.0.1:$ProxyPort/v1"
                api = "openai-completions"
                apiKey = "local"
                compat = @{
                    supportsStore = $false
                    supportsDeveloperRole = $false
                    supportsReasoningEffort = $false
                    supportsUsageInStreaming = $false
                    supportsStrictMode = $false
                    maxTokensField = "max_tokens"
                }
                models = @(
                    @{
                        id = "chapek-nine"
                        name = "Chapek Nine"
                        reasoning = $false
                        input = @("text")
                        contextWindow = $piContextWindow
                        maxTokens = $maxTokens
                        cost = @{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
                    }
                )
            }
        }
    }
    $modelsJson = $modelsConfig | ConvertTo-Json -Depth 10
    Write-Utf8NoBom (Join-Path $piAgentDir "models.json") $modelsJson

    # Pi's built-in /llama extension reads this credential. The static
    # llama-local catalog above avoids its startup catalog-refresh race.
    $authConfig = @{
        "llama.cpp" = @{
            type = "api_key"
            key = "local"
            env = @{ LLAMA_BASE_URL = "http://127.0.0.1:$Port" }
        }
    }
    $authJson = $authConfig | ConvertTo-Json -Depth 6
    Write-Utf8NoBom (Join-Path $piAgentDir "auth.json") $authJson
    return $piAgentDir
}

function Invoke-PiLauncher($Selected, $LocalModel, [string[]]$AdditionalArgs = @()) {
    $pi = Join-Path $Root "node_modules\.bin\pi.cmd"
    $env:LLAMA_BASE_URL = "http://127.0.0.1:$Port"
    $env:LLAMA_API_KEY = "local"
    $env:PI_CODING_AGENT_DIR = Write-PiLocalConfig $Selected $LocalModel
    Push-Location $Root
    try {
        $piArgs = @(
            "--approve",
            "--provider", "llama-local",
            "--model", "chapek-nine",
            "--api-key", "local"
        )
        $piArgs += $AdditionalArgs
        if (-not (Test-Path $pi)) { throw "Project-local Pi executable is missing. Run: .\harness.ps1 setup" }
        & $pi @piArgs
        if ($LASTEXITCODE -ne 0) { throw "Pi exited with code $LASTEXITCODE." }
    } finally { Pop-Location }
}

function Start-Pi {
    Start-Server
    $selected = Get-SelectedProfile
    $localModel = Get-LocalModel $selected
    Invoke-PiLauncher $selected $localModel
}

function Test-PiProfile {
    Start-Server
    $selected = Get-SelectedProfile
    $localModel = Get-LocalModel $selected
    Write-Host "Running a non-interactive Pi request through the transparent local model front door..."
    Invoke-PiLauncher $selected $localModel @(
        "--no-session",
        "--no-tools",
        "--print",
        "Reply with exactly: LOCAL PI OK"
    )
    Write-Host "Pi/transparent-router smoke test passed."
}

function Run-RoutingEvals {
    Start-Server
    $evalMode = if ($Value) { $Value.ToLowerInvariant() } else { "quick" }
    if ($evalMode -notin @("quick", "full")) { throw "Eval mode must be quick or full." }
    $env:LLAMA_BASE_URL = "http://127.0.0.1:$Port"
    & node (Join-Path $Root "scripts\run-routing-evals.mjs") `
        (Join-Path $RuntimeDir "routing-evals.json") $evalMode
    if ($LASTEXITCODE -ne 0) { throw "Routing evals failed with exit code $LASTEXITCODE." }
    Write-Host "Routing evals saved and will inform deterministic and LoRA policies."
}

function Stop-Server {
    if (-not (Test-Path $StatePath)) { Write-Host "No managed server is recorded."; return }
    $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    $proxyProcess = if ($state.proxyPid) { Get-Process -Id $state.proxyPid -ErrorAction SilentlyContinue } else { $null }
    if ($proxyProcess -and $proxyProcess.ProcessName -in @("node", "nodejs")) {
        Stop-Process -Id $proxyProcess.Id
        Write-Host "Stopped model proxy PID $($proxyProcess.Id)."
    } elseif ($proxyProcess) {
        Write-Warning "Proxy PID $($proxyProcess.Id) belongs to $($proxyProcess.ProcessName); it was not stopped."
    }
    $coordinatorProcess = if ($state.coordinatorPid) { Get-Process -Id $state.coordinatorPid -ErrorAction SilentlyContinue } else { $null }
    if ($coordinatorProcess -and $coordinatorProcess.ProcessName -like "llama-server*") {
        Stop-Process -Id $coordinatorProcess.Id
        Write-Host "Stopped coordinator PID $($coordinatorProcess.Id)."
    } elseif ($coordinatorProcess) {
        Write-Warning "Coordinator PID $($coordinatorProcess.Id) belongs to $($coordinatorProcess.ProcessName); it was not stopped."
    }
    $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -like "llama-server*") {
        Stop-Process -Id $process.Id
        Write-Host "Stopped llama-server PID $($process.Id)."
    } elseif ($process) {
        Write-Warning "State PID $($process.Id) belongs to $($process.ProcessName); it was not stopped."
    }
    Remove-Item -LiteralPath $StatePath -Force
}

switch ($Command) {
    "setup" { Install-Harness }
    "doctor" { Show-Doctor }
    "profiles" { Show-Profiles }
    "use" { Set-Profile $Profile }
    "add" { Add-ProfileRepo $Profile $Value $Extra }
    "onboard" { New-OnboardProfile $Profile $Value $Extra }
    "quant" { New-QuantVariant $Profile $Value }
    "quant-report" { & node (Join-Path $Root "scripts\quant-report.mjs") $RuntimeDir }
    "catalogue" { Update-ModelCatalogue }
    "discover" { Find-UpstreamCodingModels }
    "sandbox" { & node (Join-Path $Root "scripts\eval-sandbox.mjs") $(if ($Profile) { $Profile } else { "node-unit" }) $Value }
    "download" { Download-Profile }
    "download-all" { Download-AllProfiles }
    "download-background" { Start-BackgroundDownload }
    "verify" { Verify-Profile }
    "verify-all" { Verify-AllProfiles }
    "calibrate" { Calibrate-Profile }
    "calibrate-all" {
        if ($Profile -in @("quick", "full") -and -not $Value) { $Value = $Profile; $Profile = $null }
        Calibrate-AllProfiles
    }
    "init" {
        if ($Profile -or $Value -or $Extra) { throw "Usage: .\harness.ps1 init" }
        Initialize-AllModels
    }
    "calibration-status" { Show-CalibrationStatus }
    "probe" { Probe-Profile }
    "conformance" { Test-AdapterConformance }
    "experiment" { Run-Experiment }
    "evals" {
        # `evals quick|full` has no profile operand; shift the positional mode
        # before Start-Server resolves the selected worker profile.
        if ($Profile -in @("quick", "full") -and -not $Value) {
            $Value = $Profile
            $Profile = $null
        }
        Run-RoutingEvals
    }
    "train-coordinator" { Train-Coordinator }
    "evaluate-coordinator" { Evaluate-Coordinator }
    "improve-coordinator" { Improve-Coordinator }
    "coordinator-autopilot" { Invoke-CoordinatorAutopilot }
    "smoke" { Test-PiProfile }
    "bootstrap" { Bootstrap-Harness }
    "start" { Start-Server }
    "pi" { Start-Pi }
    "status" { Show-Doctor; if (Test-Path $StatePath) { Get-Content -Raw $StatePath } }
    "stop" { Stop-Server }
    default {
        @"
Local Pi + llama.cpp hybrid harness

  .\harness.ps1 setup
  .\harness.ps1 doctor
  .\harness.ps1 profiles
  .\harness.ps1 use <kimi-linear|kimi-linear-q3|kimi-k3|qwen-coder|glm-flash|gemma4|granite>
  .\harness.ps1 add <profile> <owner/repo> [quant]
  .\harness.ps1 onboard <name> <owner/repo> <quant>
  .\harness.ps1 quant <profile> <quant>
  .\harness.ps1 quant-report
  .\harness.ps1 catalogue
  .\harness.ps1 discover
  .\harness.ps1 sandbox [node-unit|python-unit|powershell-unit] [candidate-file]
  .\harness.ps1 bootstrap [profile]
  .\harness.ps1 download [profile]
  .\harness.ps1 download-all
  .\harness.ps1 download-background [profile]
  .\harness.ps1 verify [profile]
  .\harness.ps1 verify-all
  .\harness.ps1 calibrate [profile] [quick|full]
  .\harness.ps1 calibrate-all [quick|full]
  .\harness.ps1 init
  .\harness.ps1 calibration-status [profile]
  .\harness.ps1 probe [profile]
  .\harness.ps1 conformance
  .\harness.ps1 experiment [record] [name]
  .\harness.ps1 experiment compare <run-a.json> <run-b.json>
  .\harness.ps1 evals [profile] [quick|full]
  .\harness.ps1 evaluate-coordinator
  .\harness.ps1 improve-coordinator
  .\harness.ps1 coordinator-autopilot [once|watch|start|stop|status|install|uninstall]
  .\harness.ps1 train-coordinator
  .\harness.ps1 smoke [profile]
  .\harness.ps1 start [profile]
  .\harness.ps1 pi [profile]
  .\harness.ps1 stop

Sparse profiles place selected MoE experts in CPU/RAM and offload eligible
experts plus dense/attention work to CUDA.
"@ | Write-Host
    }
}
