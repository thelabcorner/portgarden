# Port Garden - fast-tier probe.
#
# Emits four JSON lines. The bulk data is packed into single delimited strings
# rather than one JSON object per record: a PowerShell pipeline per record costs
# ~0.3ms, and there were 1,260 of them.
#
# Packing format: 0x1F between fields, 0x1E between records. Neither byte can
# occur in a Windows filename, image path, owner name or IPv6 literal, which is
# why they were chosen over anything printable.
#
# Measured on the development machine (1,260 processes, 144 listeners, 93 owning
# pids). Every optimisation below is there because the number said so:
#
#   Get-NetTCPConnection -State Listen          795 ms
#   CIM MSFT_NetTCPConnection WHERE State = 2   500 ms   <- used
#   Get-Process (all, no user names)             83 ms
#   Get-Process -IncludeUserName (all)          293 ms
#   Get-Process -IncludeUserName (93 listeners)  61 ms   <- used
#   listener rows + parent map building         194 ms
#   netsh excluded ranges                        50 ms
#   ------------------------------------------------------
#   total                                       884 ms   (was ~2,500 ms)
#
# The four decisions that got it there:
#
#   1. The port map is read from the CIM class directly, not through
#      `Get-NetTCPConnection`. The cmdlet is a cdXML wrapper over exactly this
#      class, so this is the same data without the module layer - 295ms cheaper.
#      `State = 2` is the numeric `Listen` member of the CIM enum, which is more
#      portable than a state word, not less: "LISTENING" is translated on a
#      non-English Windows and the number is not.
#
#   2. User names are resolved only for the pids that hold a port. An LSA lookup
#      per process costs 293ms across the machine and 61ms across the 93 pids
#      that matter - and owners are only ever shown for a listener.
#
#   3. Only listener rows are emitted. The other 1,100 processes contribute a
#      count and nothing else, so shipping their names, working sets and CPU
#      counters across the process boundary was 100KB of payload for data no row
#      displays. It is now 12KB.
#
#   4. `Path` and `StartTime` are read only for listener pids. Both raise a
#      Win32Exception for any process we cannot open, PowerShell spends ~2.5ms on
#      each caught throw, and there are ~1,100 such processes.

$ErrorActionPreference = 'Stop'

function Emit($record) {
  Write-Output ($record | ConvertTo-Json -Compress -Depth 4)
}

$F = [string][char]0x1f
$R = [string][char]0x1e

# ---------------------------------------------------------------- listeners
try {
  # State 2 is the Listen member of the MSFT_NetTCPConnection state enum.
  $listeners = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State = 2')
} catch {
  Emit @{ k = 'e'; stage = 'listeners'; message = [string]$_.Exception.Message }
  exit 1
}

# A hashtable rather than a HashSet: native indexing instead of a method call,
# which costs ~1.5ms each from inside a loop.
$listenerMap = @{}
foreach ($connection in $listeners) {
  $listenerMap[[int]$connection.OwningProcess] = $true
}
$listenerPids = @($listenerMap.Keys | Sort-Object)

# ---------------------------------------------------------------- processes
$all = @(Get-Process)

# Owners, for listener pids only. A pid that exited between the two calls is
# simply absent, which is why the error action is silenced rather than fatal.
$ownerMap = @{}
if ($listenerPids.Count -gt 0) {
  foreach ($process in @(Get-Process -IncludeUserName -Id $listenerPids -ErrorAction SilentlyContinue)) {
    try {
      $name = [string]$process.UserName
      if (-not [string]::IsNullOrEmpty($name)) { $ownerMap[[int]$process.Id] = $name }
    } catch {
      # The OS withheld it; the row says "unavailable" rather than inventing one.
    }
  }
}

# Fields: pid, name, owner, image, start, workingSet, cpuTicks, sessionId
$rows = foreach ($process in $all) {
  $id = [int]$process.Id
  if ($listenerMap[$id] -ne $true) { continue }

  # The two expensive reads, and only where they are used. They also anchor the
  # identity tuple against pid reuse from the very first scan.
  $path = $null
  try { $path = [string]$process.Path } catch { $path = $null }
  $start = $null
  try { $start = $process.StartTime.ToUniversalTime().ToString('o') } catch { $start = $null }

  $workingSet = [int64]0
  try { $workingSet = [int64]$process.WorkingSet64 } catch { $workingSet = [int64]0 }

  # Ticks are 100ns units, the same unit Win32_Process reports, so the two tiers
  # can never be mixed up when CPU is derived from a delta.
  $cpu = [int64]0
  try { $cpu = [int64]$process.TotalProcessorTime.Ticks } catch { $cpu = [int64]0 }

  $session = 0
  try { $session = [int]$process.SessionId } catch { $session = 0 }

  "$id$F$([string]$process.ProcessName)$F$($ownerMap[$id])$F$path$F$start$F$workingSet$F$cpu$F$session"
}

Emit @{ k = 'pr'; v = ($rows -join $R) }

# Fields: port, pid, bindAddress
$bindings = foreach ($connection in $listeners) {
  "$([int]$connection.LocalPort)$F$([int]$connection.OwningProcess)$F$([string]$connection.LocalAddress)"
}
Emit @{ k = 'tb'; v = ($bindings -join $R) }

# --------------------------------------------------- reserved port ranges
# The raw netsh text is shipped verbatim and parsed in TypeScript, so the rule
# that has to survive a non-English Windows lives in one tested place instead of
# being duplicated here.
$excluded = ''
try { $excluded = (netsh interface ipv4 show excludedportrange protocol=tcp | Out-String) } catch { $excluded = '' }

Emit @{ k = 'r'; excluded = $excluded }

Emit @{
  k         = 'm'
  listeners = $listeners.Count
  procs     = $all.Count
  cores     = [int][Environment]::ProcessorCount
}