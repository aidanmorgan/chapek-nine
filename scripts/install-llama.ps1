[CmdletBinding()]
param(
    [ValidateSet("12.4", "13.3")]
    [string]$Cuda = "12.4"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root "runtime\llama.cpp"
$downloadDir = Join-Path $root "runtime\downloads"
$headers = @{ "User-Agent" = "local-pi-hybrid-harness"; "Accept" = "application/vnd.github+json" }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $destination, $downloadDir | Out-Null

Write-Host "Resolving the latest official llama.cpp release..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers $headers
$binary = $release.assets |
    Where-Object { $_.name -like "llama-*-bin-win-cuda-$Cuda-x64.zip" } |
    Select-Object -First 1
$runtime = $release.assets |
    Where-Object { $_.name -eq "cudart-llama-bin-win-cuda-$Cuda-x64.zip" } |
    Select-Object -First 1

if (-not $binary -or -not $runtime) {
    throw "Release $($release.tag_name) does not contain the expected Windows CUDA $Cuda bundles."
}

foreach ($asset in @($binary, $runtime)) {
    $archive = Join-Path $downloadDir $asset.name
    $expectedSize = [int64]$asset.size
    $existingSize = if (Test-Path -LiteralPath $archive) { (Get-Item -LiteralPath $archive).Length } else { 0 }
    if ($existingSize -ne $expectedSize) {
        $partial = "$archive.partial"
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        Write-Host "Downloading $($asset.name) ($([math]::Round($expectedSize / 1MB)) MiB)..."
        $downloaded = $false
        foreach ($attempt in 1..3) {
            try {
                Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $partial
                if ((Get-Item -LiteralPath $partial).Length -ne $expectedSize) {
                    throw "size mismatch: expected $expectedSize bytes"
                }
                Move-Item -LiteralPath $partial -Destination $archive -Force
                $downloaded = $true
                break
            } catch {
                Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
                if ($attempt -eq 3) { throw }
                Write-Warning "Download attempt $attempt failed; retrying."
            }
        }
        if (-not $downloaded) { throw "Failed to download $($asset.name)." }
    } else {
        Write-Host "Using verified cached archive $($asset.name)."
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
}

$server = Get-ChildItem $destination -Recurse -Filter "llama-server.exe" | Select-Object -First 1
if (-not $server) { throw "Installation completed but llama-server.exe was not found." }
Write-Host "Installed llama.cpp $($release.tag_name) (CUDA $Cuda) at $($server.FullName)"
& $server.FullName --version
$devices = & $server.FullName --list-devices 2>&1
$devices | Write-Host
if (($devices -join "`n") -notmatch "CUDA") {
    throw "CUDA bundle installed, but llama.cpp still reports no CUDA device. Check matching runtime DLLs and NVIDIA driver."
}
