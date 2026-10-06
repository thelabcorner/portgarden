# Tests whether `netstat -ano` can substitute for the CIM port query.
#
# The original reason for preferring the CIM class was that netstat's state
# column is localized - a translated "LISTENING" would break a naive match. But
# the state word is not actually needed: a socket whose FOREIGN port is 0 is a
# socket that has never been connected, which is exactly what listening means.
# That is a property of TCP, not of the display language.
#
# This checks the rule against the CIM class on this machine before it is trusted.

$ErrorActionPreference = 'Continue'

function ParseNetstat {
  param([string[]]$Lines)
  $rows = @()
  foreach ($line in $Lines) {
    # Proto  Local Address       Foreign Address     [State]        PID
    # The State column is optional and localized, so it is never matched on.
    if ($line -notmatch '^\s*TCP\s+(\S+)\s+(\S+)\s+(.+?)\s+(\d+)\s*$') { continue }
    $local = $Matches[1]
    $foreign = $Matches[2]
    $pid_ = [int]$Matches[4]

    # Only a listening socket has a foreign port of 0.
    $foreignPort = ($foreign -split ':')[-1]
    if ($foreignPort -ne '0') { continue }

    # Local address is host:port, and an IPv6 host contains colons of its own.
    $idx = $local.LastIndexOf(':')
    if ($idx -lt 1) { continue }
    $rows += [pscustomobject]@{
      Port    = [int]$local.Substring($idx + 1)
      Address = $local.Substring(0, $idx)
      Pid     = $pid_
    }
  }
  return $rows
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$tcp = (netstat -ano -p TCP | Where-Object { $_ -match '^\s*TCP' })
$tNetstat = $sw.ElapsedMilliseconds
$fromNetstat = ParseNetstat -Lines $tcp

$sw.Restart()
$fromCim = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State = 2')
$tCim = $sw.ElapsedMilliseconds

Write-Output ("netstat: {0} ms, {1} TCP lines -> {2} listeners" -f $tNetstat, $tcp.Count, $fromNetstat.Count)
Write-Output ("CIM    : {0} ms, {1} listeners" -f $tCim, $fromCim.Count)
Write-Output ''

$netstatSet = @{}
foreach ($r in $fromNetstat) { $netstatSet["$($r.Port)|$($r.Pid)"] = $r }
$cimSet = @{}
foreach ($r in $fromCim) { $cimSet["$([int]$r.LocalPort)|$([int]$r.OwningProcess)"] = $r }

$onlyNetstat = @($netstatSet.Keys | Where-Object { -not $cimSet.ContainsKey($_) })
$onlyCim = @($cimSet.Keys | Where-Object { -not $netstatSet.ContainsKey($_) })

Write-Output ("present in netstat only: " + $onlyNetstat.Count + "  " + (($onlyNetstat | Select-Object -First 8) -join ', '))
Write-Output ("present in CIM only:     " + $onlyCim.Count + "  " + (($onlyCim | Select-Object -First 8) -join ', '))
Write-Output ''

# Compare the bind addresses too, since the row shows them.
$mismatchedAddress = 0
foreach ($key in $cimSet.Keys) {
  if (-not $netstatSet.ContainsKey($key)) { continue }
  $n = $netstatSet[$key]
  $c = $cimSet[$key]
  $nAddr = $n.Address -replace '^\[|\]$', ''
  if ($nAddr -ne [string]$c.LocalAddress) { $mismatchedAddress++ }
}
Write-Output ("address differs for " + $mismatchedAddress + " of " + $cimSet.Count + " shared listeners")