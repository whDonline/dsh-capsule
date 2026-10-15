# Purpose: restart the local DSH Desktop (desktop profile) so the profile reloads the plugin's
# NEXT JavaScript generation. Why it is needed: the profile HMR only recomposes configuration and
# does not reload an already-mounted module's new code, so adapter/ changes need a DSH restart
# (see docs/治理台与生命周期.md section 1.1, Chinese-only local notes).
#
# Usage:
#   powershell -NoProfile -File scripts/restart-dsh-desktop.ps1            # build + report
#   powershell -NoProfile -File scripts/restart-dsh-desktop.ps1 -Force     # build + kill + relaunch
#
# WARNING: -Force terminates the running DSH Desktop and the sessions inside it.
# This file is intentionally ASCII-only so it stays valid under Windows PowerShell 5.1
# (which mis-decodes UTF-8 without BOM).
param(
  [switch] $Force
)
$ErrorActionPreference = "Stop"
$installRoot = "D:\mysoftware\deepseek harness"
$exe = Join-Path $installRoot "DeepSeek Harness.exe"
$asar = Join-Path $installRoot "resources\app.asar"
$asarDsh = Join-Path $asar "dsh"
# NOTE: $hostEntry lives INSIDE app.asar, so it is not visible to Test-Path; only the archive is.
$hostEntry = Join-Path $asarDsh "node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js"
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
$runtimePrimary = Join-Path $installRoot "resources\runtime\primary-runtime"
$pnpmBin = Join-Path $installRoot "resources\runtime\pnpm\bin\pnpm.mjs"
$runtimeBin = Join-Path $installRoot "resources\runtime\bin"
foreach ($path in @($exe, $asar, $profileDir, $runtimePrimary, $pnpmBin, $runtimeBin)) {
  if (-not (Test-Path $path)) { throw "missing path: $path" }
}
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  Write-Host "[restart-dsh] building @dsh-capsule/adapter ..."
  & pnpm build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
$running = Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -like "*dsh-desktop-host*" }
if ($running) {
  if (-not $Force) {
    Write-Host "[restart-dsh] DSH Desktop is running (PID $($running.ProcessId -join ', '))."
    Write-Host "[restart-dsh] Re-run with -Force to stop and relaunch it, or close the app manually and re-run."
    return
  }
  Write-Host "[restart-dsh] stopping: $($running.ProcessId -join ', ')"
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
Write-Host "[restart-dsh] launching DSH Desktop (desktop profile) ..."
Start-Process -FilePath $exe -ArgumentList @(
  "--expose-internals", $hostEntry, $asarDsh, $profileDir, $runtimePrimary, $pnpmBin, $runtimeBin
)
Write-Host "[restart-dsh] launched. After ~10s self-check with:"
Write-Host "  Invoke-WebRequest http://127.0.0.1:19387/guard/api/config -UseBasicParsing | Select-Object StatusCode"
Write-Host "  (Invoke-WebRequest http://127.0.0.1:8787/api/snapshot -UseBasicParsing -Headers @{Origin='http://127.0.0.1:19387'}).Headers['Access-Control-Allow-Origin']"
