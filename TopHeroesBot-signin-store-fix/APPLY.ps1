$ErrorActionPreference = "Stop"

$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-Location

$files = @(
    @{ Source = Join-Path $packageRoot "core\auth.mjs"; Destination = Join-Path $projectRoot "core\auth.mjs" },
    @{ Source = Join-Path $packageRoot "core\api.mjs"; Destination = Join-Path $projectRoot "core\api.mjs" },
    @{ Source = Join-Path $packageRoot "features\signin\signin.mjs"; Destination = Join-Path $projectRoot "features\signin\signin.mjs" }
)

foreach ($file in $files) {
    if (-not (Test-Path $file.Source)) {
        throw "缺少补丁文件: $($file.Source)"
    }

    $destinationDirectory = Split-Path -Parent $file.Destination
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

    if (Test-Path $file.Destination) {
        Copy-Item $file.Destination "$($file.Destination).bak-20260803" -Force
    }

    Copy-Item $file.Source $file.Destination -Force
    Write-Host "已覆盖: $($file.Destination)"
}

node --check (Join-Path $projectRoot "core\auth.mjs")
node --check (Join-Path $projectRoot "core\api.mjs")
node --check (Join-Path $projectRoot "features\signin\signin.mjs")

Write-Host "修正包已应用，语法检查通过。"
