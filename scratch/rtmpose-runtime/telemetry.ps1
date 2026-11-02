param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [ValidateRange(1,3600)][int]$DurationSeconds = 600
)
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite telemetry directory: $target" }
New-Item -ItemType Directory -Path $target | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
$jsonl = [System.IO.StreamWriter]::new((Join-Path $target 'host-telemetry.jsonl'), $false, $utf8)
$csv = [System.IO.StreamWriter]::new((Join-Path $target 'host-telemetry.csv'), $false, $utf8)
$csv.WriteLine('timestamp_utc,elapsed_s,cpu_total_percent,available_ram_bytes,gpu_dedicated_bytes,gpu_shared_bytes,gpu_busiest_engine_sum_percent,processor_frequency_mhz,processor_performance_percent')
$counterPaths = @(
    '\GPU Engine(*)\Utilization Percentage',
    '\GPU Process Memory(*)\Dedicated Usage',
    '\GPU Process Memory(*)\Shared Usage',
    '\Processor(_Total)\% Processor Time',
    '\Memory\Available Bytes',
    '\Thermal Zone Information(*)\Temperature',
    '\Thermal Zone Information(*)\High Precision Temperature',
    '\Processor Information(_Total)\Processor Frequency',
    '\Processor Information(_Total)\% Processor Performance'
)
$os = Get-CimInstance Win32_OperatingSystem
$metadata = @{
    started_utc = [DateTime]::UtcNow.ToString('o'); source = 'Windows native performance counters, read-only';
    computer = $env:COMPUTERNAME; physical_ram_bytes = [double]$os.TotalVisibleMemorySize * 1024;
    requested_counters = $counterPaths; gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion);
    active_power_scheme = ((& powercfg /getactivescheme 2>$null) -join ' ');
    battery = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object BatteryStatus,EstimatedChargeRemaining);
    limitations = @('GPU Engine counters describe all host processes; they are not model-specific GPU kernel attribution.',
      'GPU Process Memory counters are per-process allocations; shared buffers can be counted more than once in aggregate.',
      'Thermal counters are raw ACPI thermal-zone observations, not verified CPU/GPU die temperatures. Missing die temperature is N/A.',
      'No wattage or Windows power-mode inference is fabricated. Active scheme and available battery metadata are recorded.',
      'Counter timestamps are UTC; correlate with benchmark wall-clock start/end and source timeline separately.')
}
[System.IO.File]::WriteAllText((Join-Path $target 'metadata.json'), ($metadata | ConvertTo-Json -Depth 6), $utf8)
$clock = [System.Diagnostics.Stopwatch]::StartNew()
try {
    while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds -and !(Test-Path -LiteralPath (Join-Path $target 'stop-telemetry.flag'))) {
        $samples = @(Get-Counter -Counter $counterPaths -MaxSamples 1 -ErrorAction SilentlyContinue |
            ForEach-Object { $_.CounterSamples } | Where-Object { $_.Status -eq 0 -and [double]::IsFinite($_.CookedValue) })
        $rows = @($samples | ForEach-Object { @{ path=$_.Path; instance=$_.InstanceName; value=$_.CookedValue } })
        $timestamp = [DateTime]::UtcNow.ToString('o')
        $gpuRows = @($samples | Where-Object { $_.Path -like '*gpu engine*utilization percentage' })
        $engines = @($gpuRows | Group-Object { $_.InstanceName -replace '^pid_\d+_', '' } | ForEach-Object {
            @{ engine=$_.Name; utilization_percent_sum=($_.Group | Measure-Object CookedValue -Sum).Sum }
        })
        $processes = @(Get-Process -Name msedge,python,pythonw,node -ErrorAction SilentlyContinue | ForEach-Object {
            @{ pid=$_.Id; name=$_.ProcessName; cpu_seconds=$_.CPU; working_set_bytes=$_.WorkingSet64; private_bytes=$_.PrivateMemorySize64 }
        })
        $sample = @{ timestamp_utc=$timestamp; elapsed_s=$clock.Elapsed.TotalSeconds; counters=$rows; gpu_engines=$engines;
            processes=$processes; cpu_gpu_die_temperature_celsius=$null; power_watts=$null }
        $jsonl.WriteLine(($sample | ConvertTo-Json -Depth 7 -Compress)); $jsonl.Flush()
        function ValueFor([string]$pattern) {
            $matched = @($samples | Where-Object { $_.Path -like $pattern })
            if ($matched.Count -eq 0) { return '' }
            return ($matched | Measure-Object CookedValue -Sum).Sum.ToString('R',[Globalization.CultureInfo]::InvariantCulture)
        }
        $busy = if ($engines.Count) { ($engines | Measure-Object utilization_percent_sum -Maximum).Maximum.ToString('R',[Globalization.CultureInfo]::InvariantCulture) } else { '' }
        $csv.WriteLine((@($timestamp, $clock.Elapsed.TotalSeconds.ToString('F3',[Globalization.CultureInfo]::InvariantCulture),
            (ValueFor '*processor(_total)*% processor time'), (ValueFor '*memory*available bytes'),
            (ValueFor '*gpu process memory*dedicated usage'), (ValueFor '*gpu process memory*shared usage'), $busy,
            (ValueFor '*processor information(_total)*processor frequency'), (ValueFor '*processor information(_total)*% processor performance')) -join ','))
        $csv.Flush()
        # Get-Counter itself samples at a one-second interval. Do not add a second sleep.
    }
} finally {
    $jsonl.Dispose(); $csv.Dispose()
    [System.IO.File]::WriteAllText((Join-Path $target 'completed.json'), (@{ ended_utc=[DateTime]::UtcNow.ToString('o'); elapsed_s=$clock.Elapsed.TotalSeconds } | ConvertTo-Json), $utf8)
}
