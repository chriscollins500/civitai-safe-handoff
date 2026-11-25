param([Parameter(Mandatory)][int] $RootProcessId)

$processes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='firefox.exe'"
$known = [System.Collections.Generic.HashSet[int]]::new()
$null = $known.Add($RootProcessId)
do {
    $before = $known.Count
    foreach ($process in $processes) {
        if ($known.Contains([int]$process.ParentProcessId)) {
            $null = $known.Add([int]$process.ProcessId)
        }
    }
} while ($known.Count -ne $before)

$matched = @($processes | Where-Object { $known.Contains([int]$_.ProcessId) })
if (-not ($matched | Where-Object { $_.ProcessId -eq $RootProcessId })) { exit 2 }

$working = ($matched | Measure-Object -Property WorkingSetSize -Sum).Sum
$private = ($matched | Measure-Object -Property PrivatePageCount -Sum).Sum
[pscustomobject]@{
    processes = $matched.Count
    workingSetBytes = [long]$working
    privateBytes = [long]$private
} | ConvertTo-Json -Compress
