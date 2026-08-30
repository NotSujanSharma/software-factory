<#
.SYNOPSIS
  Keeps `factory auto` running with no human involvement.

.DESCRIPTION
  `factory auto` already absorbs session limits, parked stages and failed heals on
  its own. What it cannot survive is losing its own process: agents run shell
  commands, and a blunt one (`taskkill /IM node.exe`, `pkill -f node`) takes the
  orchestrator down with the app it was trying to stop. A Node watchdog would die
  to the same command, so this one is PowerShell.

  Pipeline state lives in workspace/<app>/.factory/state.json, so a restart resumes
  where it left off: passed stages are skipped, interrupted work is re-armed.

.EXAMPLE
  .\scripts\auto-watchdog.ps1 -App todo-api

.EXAMPLE
  .\scripts\auto-watchdog.ps1 -App shop -Prompt "an ecommerce app for handmade goods"
#>
[CmdletBinding()]
param(
  # App name in workspace/. Created from -Prompt when it does not exist yet.
  [Parameter(Mandatory = $true)][string]$App,

  # Build prompt. Only needed the first time an app is created.
  [string]$Prompt = "",

  # Pause between restarts, so a crash loop does not spin.
  [int]$RestartDelaySeconds = 15,

  # 0 = restart forever.
  [int]$MaxRestarts = 0,

  # Relaunch itself as an independent process and return immediately. The watchdog
  # then survives the shell that started it (terminal closed, session ended), which
  # a child process does not. It does NOT survive a reboot - use a Scheduled Task
  # for that. Stop it with: Stop-Process -Id (Get-Content .factory-watchdog.pid)
  [switch]$Detached,

  # Where a detached run writes its log.
  [string]$LogFile = ""
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Watchdog([string]$Message) {
  Write-Host "[watchdog $(Get-Date -Format 'HH:mm:ss')] $Message"
}

if ($Detached) {
  $log = if ($LogFile) { $LogFile } else { Join-Path $root "watchdog-$App.log" }
  $pidFile = Join-Path $root ".factory-watchdog.pid"

  # Every path/value is quoted: this repo can live under a path with spaces
  # ("OneDrive - RAVL"), and an unquoted -File argument silently starts an
  # interactive shell that exits immediately instead of running the script.
  $childArgs = @(
    "-ExecutionPolicy", "Bypass", "-NoProfile",
    "-File", "`"$PSCommandPath`"",
    "-App", "`"$App`"",
    "-RestartDelaySeconds", "$RestartDelaySeconds",
    "-MaxRestarts", "$MaxRestarts"
  )
  if ($Prompt) { $childArgs += @("-Prompt", "`"$Prompt`"") }

  $proc = Start-Process -FilePath "powershell" -ArgumentList $childArgs `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"

  Set-Content -Path $pidFile -Value $proc.Id -Encoding utf8
  Write-Watchdog "detached watchdog started (PID $($proc.Id))"
  Write-Watchdog "log:  $log"
  Write-Watchdog "stop: Stop-Process -Id $($proc.Id) -Force   (PID also in $pidFile)"
  Write-Watchdog "note: survives this terminal, NOT a reboot"
  return
}

Write-Watchdog "supervising 'factory auto' for '$App' in $root"
Write-Watchdog "stop with Ctrl+C; the app itself keeps running (use 'npm run factory -- stop $App')"

$run = 0
while ($true) {
  $run++
  Write-Watchdog "starting factory auto (run #$run)"

  if ($Prompt -and $run -eq 1) {
    npm run factory -- auto --name $App $Prompt
  } else {
    npm run factory -- auto --app $App
  }
  $code = $LASTEXITCODE

  if ($code -eq 0) {
    Write-Watchdog "factory auto finished cleanly - nothing left to supervise"
    break
  }

  Write-Watchdog "factory auto exited with code $code (killed or crashed)"
  if ($MaxRestarts -gt 0 -and $run -ge $MaxRestarts) {
    Write-Watchdog "restart budget of $MaxRestarts spent - stopping"
    break
  }

  Write-Watchdog "restarting in ${RestartDelaySeconds}s; state resumes from .factory/state.json"
  Start-Sleep -Seconds $RestartDelaySeconds
}
