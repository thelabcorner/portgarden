# Stops Port Garden, and only Port Garden.
#
# This machine runs at least three Electron applications side by side (Port
# Garden, opencode and the OpenFork desktop host), so `Stop-Process -Name
# electron` is not an option - it would take the others with it.
#
# Port Garden is identified by its pid file first, falling back to the window it
# owns. The pid file is the reliable path: a tray-only instance has no window, and
# Electron's executable path does not contain the app name, so a
# `CommandLine -like '*portgarden*'` filter matches the helper processes and
# misses the main process entirely. That combination is how a stale instance kept
# holding the single-instance lock while looking stopped.
#
# The recorded start time is checked before anything is killed, for the same
# reason the app checks process identity before terminating one: Windows recycles
# pids, and a stale pid file would otherwise point at an unrelated process.

param([switch]$WhatIf)

$pidFile = Join-Path $env:APPDATA 'portgarden\portgarden.pid'
$target = $null

if (Test-Path -LiteralPath $pidFile) {
  try {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $candidate = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($candidate) {
      $actual = [DateTimeOffset]::new($candidate.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
      $drift = [Math]::Abs($actual - [int64]$record.startedAt)
      if ($drift -lt 5000) {
        $target = $candidate
        Write-Output ("pid file: pid=$($candidate.Id) version=$($record.version) drift=$([Math]::Round($drift))ms")
      } else {
        Write-Output ("pid file is stale: pid $($record.pid) now belongs to a process started $([Math]::Round($drift)) ms away. Ignoring it.")
      }
    } else {
      Write-Output "pid file names pid $($record.pid), which is not running. Removing it."
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Output "pid file unreadable: $($_.Exception.Message)"
  }
}

if (-not $target) {
  $target = Get-Process | # A prefix match: the demo page's document title is 'Port Garden - interface preview'.#
  Where-Object { $_.MainWindowTitle -like 'Port Garden*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($target) { Write-Output "window match: pid=$($target.Id)" }
}

if (-not $target) {
  Write-Output 'not running'
  exit 0
}

if ($WhatIf) {
  Write-Output 'would stop it'
  exit 0
}

# /T takes the GPU and renderer children with it; killing only the main process
# would leave them behind.
& taskkill.exe /PID $target.Id /T /F | Out-Null
Start-Sleep -Milliseconds 1500

$remaining = Get-Process -Id $target.Id -ErrorAction SilentlyContinue
Write-Output ("stopped" + $(if ($remaining) { ' (main process still present)' } else { '' }))
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue