# Port Garden - detail tier.
#
# Two jobs, one pass over the process table:
#
#   1. The parent pid for every process, so the parent chain and the child scope
#     Port Garden shows before a terminate are complete rather than one level
#     deep.
#   2. The command line and image path, but only for pids that actually hold a
#     listening port. Every process's command line is a plausible place for a
#     token to appear in an argument, so the ones nobody will ever look at are
#     never read into memory.
#
# The table is read *unfiltered*, and that is a measured decision.
# `Get-CimInstance Win32_Process -Filter "ProcessId = 1 OR ProcessId = 2 OR ..."`
# fails with "Quota violation" on a machine with a few thousand processes, because
# WQL caps the clauses in a disjunction. Filtering does not save time either: a
# 74-clause filter measured 2871 ms against 3031 ms unfiltered. The cost is
# provider start-up, not rows.
#
# Measured cold on the development machine (1180 processes, 74 listeners):
#
#   PowerShell start-up           ~400 ms
#   projected Win32_Process read ~2800 ms   irreducible
#   parent map packing             ~13 ms
#   74 listener rows packed        ~10 ms
#   the first version of this      6300 ms
#
# Three mistakes this file used to make, each found by measurement rather than
# reasoning:
#
#   * `$hashset.Add()` per process. A .NET method call from inside a PowerShell
#     loop costs about 1.5 ms, so 1180 calls were about 1.7 seconds. Now a
#     hashtable index, assigned natively.
#   * A chained StringBuilder for the parent map: 7301 ms, against 13 ms for the
#     same data built with `foreach { "..." } -join`.
#   * One JSON object per process: 1180 serialisations at about 2.4ms each. The
#     listener rows are now packed into one string.
#
# Usage: detail.ps1 -DetailPid "1234,5678"

param(
  [string]$DetailPid = ''
)

$ErrorActionPreference = 'Stop'

function Emit($record) {
  Write-Output ($record | ConvertTo-Json -Compress -Depth 4)
}

$F = [string][char]0x1f
$R = [string][char]0x1e

$detail = @(foreach ($entry in ($DetailPid -split ',')) {
    if ($entry -match '^\s*\d+\s*$') { [int]$entry.Trim() }
  })

$processes = $null
try {
  $processes = @(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CommandLine,ExecutablePath,CreationDate FROM Win32_Process')
} catch {
  Emit @{ k = 'e'; stage = 'detail'; message = [string]$_.Exception.Message }
  exit 0
}

# A native hashtable rather than a HashSet[int]: assigning a key costs nothing
# measurable, while `$set.Add()` inside this loop cost about 1.7 seconds.
$index = @{}
foreach ($process in $processes) {
  $index[[int]$process.ProcessId] = $process
}

# The whole parent map in one string. `foreach { "..." } -join ','` runs entirely
# in the runtime; the StringBuilder this used to be was 560x slower.
$parents = foreach ($process in $processes) {
  "$([int]$process.ProcessId):$([int]$process.ParentProcessId)"
}
# pid 0 here means "no parent"; the caller maps it to null rather than treating
# the boot pseudo-process as a real ancestor.
Emit @{ k = 'pm'; v = ($parents -join ',') }

# Only the requested pids are serialised, so only those pay for the command line,
# the image path and the date conversion. Windows refuses the first two for
# protected processes, which is exactly why they are worth having.
$rows = [System.Collections.Generic.List[string]]::new()
$gone = [System.Collections.Generic.List[int]]::new()

foreach ($id in $detail) {
  $process = $index[$id]
  if ($null -eq $process) {
    # Asked about and absent: the process exited or became unreadable. Reporting
    # it is what lets the caller say "N processes disappeared" rather than quietly
    # showing a row with nothing in it.
    $gone.Add($id)
    continue
  }

  $command = $null
  if (-not [string]::IsNullOrEmpty([string]$process.CommandLine)) { $command = [string]$process.CommandLine }

  $image = $null
  if (-not [string]::IsNullOrEmpty([string]$process.ExecutablePath)) { $image = [string]$process.ExecutablePath }

  $start = $null
  if ($null -ne $process.CreationDate) {
    $start = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
  }

  # Fields: pid, commandLine, imagePath, start
  $rows.Add("$id$F$command$F$image$F$start")
}

if ($rows.Count -gt 0) { Emit @{ k = 'dd'; v = ($rows -join $R) } }
if ($gone.Count -gt 0) { Emit @{ k = 'gg'; v = ($gone -join ',') } }