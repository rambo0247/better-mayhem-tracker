# Starts the packaged exe from a temp folder, the way a player runs a download. A runner
# has no display to speak of, so still running after 15 s is the check.
param([Parameter(Mandatory = $true)][string]$Exe)

$dir = Join-Path $env:RUNNER_TEMP "bmt-launch"
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item $Exe $dir
$p = Start-Process -FilePath (Join-Path $dir (Split-Path $Exe -Leaf)) -PassThru
Start-Sleep -Seconds 15
$exited = $p.HasExited
if (-not $exited) { Stop-Process -Id $p.Id -Force }
if ($exited) { throw "The exe exited on its own with code $($p.ExitCode)" }
