# Measures the candidate fast-tier optimisations against this machine, so the
# changes are chosen from numbers rather than from plausibility.
$ErrorActionPreference = 'Continue'

function Time($label, [scriptblock]$body) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = & $body
  $sw.Stop()
  Write-Output ("{0,-52} {1,6} ms   n={2}" -f $label, $sw.ElapsedMilliseconds, ($r | Measure-Object).Count)
}

# --- who owns a listening socket ---------------------------------------------
$listeners = @(Get-NetTCPConnection -State Listen)
$listenerPids = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
$processCount = @(Get-Process).Count
Write-Output "listeners=$($listeners.Count)  distinct listener pids=$($listenerPids.Count)  processes=$processCount"
Write-Output ''

Time 'Get-Process (no user names)' { Get-Process }
Time 'Get-Process -IncludeUserName (all)' { Get-Process -IncludeUserName }
Time 'Get-Process -IncludeUserName -Id (listeners)' { Get-Process -IncludeUserName -Id $listenerPids }

Write-Output ''
Write-Output '--- host start-up ---'
$pwshPath = (Get-Command pwsh).Source
$winPsPath = (Get-Command powershell).Source
foreach ($pair in @(@('pwsh 7', $pwshPath), @('Windows PowerShell 5.1', $winPsPath))) {
  $label = $pair[0]; $exe = $pair[1]
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $exe -NoProfile -NonInteractive -Command 'exit 0'
  $sw.Stop()
  Write-Output ("{0,-52} {1,6} ms   (bare start-up)" -f $label, $sw.ElapsedMilliseconds)
}

Write-Output ''
Write-Output '--- netsh ---'
Time 'netsh excludedportrange' { (netsh interface ipv4 show excludedportrange protocol=tcp | Out-String) }
Time 'netsh dynamicport' { (netsh interface ipv4 show dynamicport tcp | Out-String) }