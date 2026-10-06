# Compares the warm probe host against one-shot spawns, using the same protocol
# the app uses. This is the measurement that decides whether the host earns its
# keep: the win is PowerShell + CIM client start-up, paid on every spawn, so it
# only shows up on the second and later requests.

$ErrorActionPreference = 'Continue'
$script = Join-Path (Get-Location) 'resources\probe\fast.ps1'
$sentinel = '###PORTGARDEN-END###'

function Measure-OneShot([int]$runs) {
  $times = @()
  for ($i = 0; $i -lt $runs; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = & pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script
    $sw.Stop()
    $times += $sw.ElapsedMilliseconds
  }
  return $times
}

function Measure-Warm([int]$runs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command pwsh).Source
  $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -Command -'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.StandardInput.WriteLine("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8")

  $times = @()
  for ($i = 0; $i -lt $runs; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc.StandardInput.WriteLine("& '$script'")
    $proc.StandardInput.WriteLine("Write-Output '$sentinel'")
    $lines = 0
    while ($true) {
      $line = $proc.StandardOutput.ReadLine()
      if ($null -eq $line) { break }
      if ($line -eq $sentinel) { break }
      $lines++
    }
    $sw.Stop()
    $times += $sw.ElapsedMilliseconds
  }
  $proc.StandardInput.Close()
  $proc.Kill()
  return $times
}

Write-Output 'one-shot spawns (this is the current design):'
$oneShot = Measure-OneShot 3
Write-Output ("  " + ($oneShot -join ' ms, ') + ' ms')

Write-Output 'warm host (one process, repeated requests):'
$warm = Measure-Warm 5
Write-Output ("  " + ($warm -join ' ms, ') + ' ms')

Write-Output ''
$oneShotAvg = ($oneShot | Measure-Object -Average).Average
$warmSteady = ($warm | Select-Object -Skip 1 | Measure-Object -Average).Average
Write-Output ("one-shot average : {0:N0} ms" -f $oneShotAvg)
Write-Output ("warm steady state: {0:N0} ms" -f $warmSteady)
Write-Output ("saving per scan  : {0:N0} ms  ({1:N0}%)" -f ($oneShotAvg - $warmSteady), (100 * ($oneShotAvg - $warmSteady) / $oneShotAvg))