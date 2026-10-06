# Compares the port-map source and prototypes the optimised fast tier end to end.
$ErrorActionPreference = 'Continue'

function Time($label, [scriptblock]$body) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = & $body
  $sw.Stop()
  Write-Output ("{0,-56} {1,6} ms   n={2}" -f $label, $sw.ElapsedMilliseconds, ($r | Measure-Object).Count)
}

Write-Output '--- port map: typed cmdlet vs the raw CIM class beneath it ---'
Time 'Get-NetTCPConnection -State Listen' { Get-NetTCPConnection -State Listen }
Time 'Cim MSFT_NetTCPConnection (State=2, no filter)' { Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection }
Time 'Cim MSFT_NetTCPConnection (WHERE State=2)' { Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State = 2' }

Write-Output ''
Write-Output '--- candidate: query projection, which is the whole point of using CIM directly ---'
Time 'Cim MSFT_NetTCPConnection -Property 4 cols' {
  Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Property LocalAddress, LocalPort, OwningProcess, State
}

Write-Output ''
Write-Output '--- optimised fast tier, prototype ---'
function Prototype {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $listeners = @(Get-NetTCPConnection -State Listen)
  $tListeners = $sw.ElapsedMilliseconds

  $listenerMap = @{}
  foreach ($c in $listeners) { $listenerMap[[int]$c.OwningProcess] = $true }
  $listenerPids = @($listenerMap.Keys | Sort-Object)
  $tMap = $sw.ElapsedMilliseconds

  # Every process, cheap properties only. No user names: an LSA lookup per
  # process is 293 ms for the machine, and owners are only needed for the handful
  # of pids that hold a port.
  $all = @(Get-Process)
  $tAll = $sw.ElapsedMilliseconds

  $ownerMap = @{}
  if ($listenerPids.Count -gt 0) {
    foreach ($p in (Get-Process -IncludeUserName -Id $listenerPids -ErrorAction SilentlyContinue)) {
      try { $ownerMap[[int]$p.Id] = [string]$p.UserName } catch { }
    }
  }
  $tOwners = $sw.ElapsedMilliseconds

  $F = [string][char]0x1f
  $rows = foreach ($p in $all) {
    $id = [int]$p.Id
    if ($listenerMap[$id] -ne $true) { continue }
    $owner = $ownerMap[$id]
    $path = $null
    try { $path = [string]$p.Path } catch { $path = $null }
    $start = $null
    try { $start = $p.StartTime.ToUniversalTime().ToString('o') } catch { $start = $null }
    $ws = [int64]0
    try { $ws = [int64]$p.WorkingSet64 } catch { }
    $cpu = [int64]0
    try { $cpu = [int64]$p.TotalProcessorTime.Ticks } catch { }
    $sid = 0
    try { $sid = [int]$p.SessionId } catch { }
    "$id$F$([string]$p.ProcessName)$F$owner$F$path$F$start$F$ws$F$cpu$F$sid"
  }
  $packed = ($rows -join [string][char]0x1e)
  $tRows = $sw.ElapsedMilliseconds

  $binds = foreach ($c in $listeners) { "$([int]$c.LocalPort)$F$([int]$c.OwningProcess)$F$([string]$c.LocalAddress)" }
  $packedBinds = ($binds -join [string][char]0x1e)
  $tBinds = $sw.ElapsedMilliseconds

  $excluded = (netsh interface ipv4 show excludedportrange protocol=tcp | Out-String)
  $dynamic = (netsh interface ipv4 show dynamicport tcp | Out-String)
  $tNetsh = $sw.ElapsedMilliseconds

  Write-Output ("  listeners={0} listenerPids={1} processes={2}" -f $listeners.Count, $listenerPids.Count, $all.Count)
  Write-Output ("  Get-NetTCPConnection={0}  listenerMap={1}  Get-Process={2}  owners(listeners only)={3}" -f $tListeners, ($tMap - $tListeners), ($tAll - $tMap), ($tOwners - $tAll))
  Write-Output ("  buildRows={0}  buildBindings={1}  netsh={2}" -f ($tRows - $tOwners), ($tBinds - $tRows), ($tNetsh - $tBinds))
  Write-Output ("  TOTAL={0} ms   packedRows={1} bytes   packedBinds={2} bytes" -f $tNetsh, $packed.Length, $packedBinds.Length)
}

Prototype