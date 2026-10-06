# Port Garden - live identity probe.
#
# Reads back exactly the three things that make a process identifiable: its pid,
# its creation instant and its image path. Called immediately before a kill so
# the tuple the user clicked can be compared against the live system rather than
# against the last scan.
#
# This is deliberately a separate, single-pid script. Re-reading a full
# Win32_Process table would cost 2.1-2.3s, and a kill should not make the user
# wait two seconds to find out whether Windows would even allow it.
#
# Usage: identity.ps1 -ProcessId 1234

param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId
)

$ErrorActionPreference = 'Stop'

function Emit($record) {
  Write-Output ($record | ConvertTo-Json -Compress -Depth 4)
}

$process = $null
try {
  $process = Get-Process -Id $ProcessId -IncludeUserName -ErrorAction Stop
} catch {
  $process = $null
}

if ($null -eq $process) {
  Emit @{ k = 'missing'; pid = $ProcessId }
  exit 0
}

$owner = $null
try { $owner = [string]$process.UserName } catch { $owner = $null }
if ([string]::IsNullOrEmpty($owner)) { $owner = $null }

$image = $null
try { $image = [string]$process.Path } catch { $image = $null }
if ([string]::IsNullOrEmpty($image)) { $image = $null }

$created = $null
try { $created = $process.StartTime.ToUniversalTime().ToString('o') } catch { $created = $null }

Emit @{
  k     = 'i'
  pid   = [int]$process.Id
  name  = [string]$process.ProcessName
  own   = $owner
  st    = $created
  image = $image
}