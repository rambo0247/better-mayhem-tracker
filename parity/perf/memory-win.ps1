param([Parameter(Mandatory = $true)][int]$RootPid)

$ErrorActionPreference = 'Stop'

$procs = Get-CimInstance Win32_Process
$perf = @{}
foreach ($row in Get-CimInstance Win32_PerfFormattedData_PerfProc_Process) {
  $perf[[int]$row.IDProcess] = $row
}

$tree = New-Object System.Collections.Generic.List[object]
$queue = New-Object System.Collections.Generic.Queue[int]
$queue.Enqueue($RootPid)
$seen = @{}
while ($queue.Count -gt 0) {
  $current = $queue.Dequeue()
  if ($seen.ContainsKey($current)) { continue }
  $seen[$current] = $true
  $self = $procs | Where-Object { $_.ProcessId -eq $current }
  if ($null -eq $self) { continue }
  $tree.Add($self)
  foreach ($child in ($procs | Where-Object { $_.ParentProcessId -eq $current })) {
    $queue.Enqueue([int]$child.ProcessId)
  }
}

$members = @()
$missing = @()
foreach ($p in $tree) {
  $id = [int]$p.ProcessId
  if (-not $perf.ContainsKey($id)) { $missing += $id; continue }
  $members += [pscustomobject]@{
    pid = $id
    ppid = [int]$p.ParentProcessId
    name = $p.Name
    commandLine = $p.CommandLine
    executablePath = $p.ExecutablePath
    startedMs = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
    privateWorkingSetBytes = [int64]$perf[$id].WorkingSetPrivate
    workingSetBytes = [int64]$perf[$id].WorkingSet
  }
}

[pscustomobject]@{
  rootPid = $RootPid
  members = $members
  missing = $missing
  privateWorkingSetBytes = ($members | Measure-Object -Property privateWorkingSetBytes -Sum).Sum
  workingSetBytes = ($members | Measure-Object -Property workingSetBytes -Sum).Sum
} | ConvertTo-Json -Depth 4 -Compress
