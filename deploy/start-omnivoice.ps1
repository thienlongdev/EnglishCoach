param(
    [string]$PythonPath = 'C:\Anaconda\python.exe',
    [string]$BindHost = $env:OMNIVOICE_HOST,
    [string]$EnvFilePath = $env:EC_AI_ENV_FILE
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$expectedVoices = @('us_male', 'us_female', 'uk_male', 'uk_female')

function Resolve-OmniVoiceBindHost {
    param([string]$RequestedHost)
    if (-not [string]::IsNullOrWhiteSpace($RequestedHost)) {
        return $RequestedHost.Trim()
    }
    try {
        $tailscaleIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.InterfaceAlias -match 'Tailscale' -or
                $_.IPAddress -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.'
            } |
            Select-Object -ExpandProperty IPAddress)
        if ($tailscaleIps.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($tailscaleIps[0])) {
            return $tailscaleIps[0].Trim()
        }
    } catch { }
    try {
        if (Get-Command tailscale -ErrorAction SilentlyContinue) {
            $cliIp = (& tailscale ip -4 2>$null | Select-Object -First 1)
            if (-not [string]::IsNullOrWhiteSpace($cliIp) -and $cliIp.Trim() -match '^\d{1,3}(\.\d{1,3}){3}$') {
                return $cliIp.Trim()
            }
        }
    } catch { }
    return '127.0.0.1'
}

function Import-ServiceKeyFromEnvFile {
    param([string[]]$CandidatePaths)
    if (-not [string]::IsNullOrWhiteSpace($env:OMNIVOICE_SERVICE_KEY) -or -not [string]::IsNullOrWhiteSpace($env:AI_SERVICE_KEY)) {
        return
    }
    foreach ($candidate in $CandidatePaths) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        foreach ($line in (Get-Content -LiteralPath $candidate -ErrorAction SilentlyContinue)) {
            $trimmed = $line.Trim()
            if ([string]::IsNullOrEmpty($trimmed) -or $trimmed.StartsWith('#')) { continue }
            $idx = $trimmed.IndexOf('=')
            if ($idx -lt 1) { continue }
            $k = $trimmed.Substring(0, $idx).Trim()
            if ($k -ne 'OMNIVOICE_SERVICE_KEY' -and $k -ne 'AI_SERVICE_KEY') { continue }
            $v = $trimmed.Substring($idx + 1).Trim()
            if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
                if ($v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
            }
            if (-not [string]::IsNullOrWhiteSpace($v)) {
                [Environment]::SetEnvironmentVariable($k, $v, 'Process')
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($env:OMNIVOICE_SERVICE_KEY) -or -not [string]::IsNullOrWhiteSpace($env:AI_SERVICE_KEY)) {
            return
        }
    }
}

$resolvedHost = Resolve-OmniVoiceBindHost -RequestedHost $BindHost
$probeHosts = @($resolvedHost)
if ($resolvedHost -ne '127.0.0.1') { $probeHosts += '127.0.0.1' }
$probeReady = $false
foreach ($probeHost in $probeHosts) {
    try {
        $health = Invoke-RestMethod -Uri "http://${probeHost}:8005/health" -TimeoutSec 5
        if ($health.service -eq 'omnivoice-local-tts' -and $health.model_loaded -and
            -not (Compare-Object $expectedVoices @($health.voices))) {
            Write-Output 'Existing four-voice service is ready.'
            $probeReady = $true
            break
        }
        throw 'Port 8005 has a different or unready service. Inspect it; do not replace it automatically.'
    } catch {
        if ($probeHost -eq $probeHosts[-1] -and (Get-NetTCPConnection -LocalPort 8005 -State Listen -ErrorAction SilentlyContinue)) {
            throw
        }
    }
}
if ($probeReady) { exit 0 }

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw 'The existing Python runtime is missing.' }
foreach ($name in @('male_american.wav','female_american.wav','male_british.wav','female_british.wav')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot "data\OmniVoice_Sources\$name") -PathType Leaf)) {
        throw "Canonical reference voice is missing: $name"
    }
}

Import-ServiceKeyFromEnvFile -CandidatePaths @(
    $EnvFilePath,
    (Join-Path $taskRoot 'deploy\ai\ai-gpu.env'),
    (Join-Path $env:USERPROFILE '.englishcoach\ai-gpu.env')
)

$taskLogs = Join-Path $taskRoot 'storage\tts-runtime'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:PYTHONUNBUFFERED = '1'
$env:OMNIVOICE_HOST = $resolvedHost
$env:PORT = '8005'
$taskArguments = @{
    FilePath = $PythonPath
    ArgumentList = @('"scripts/run_omnivoice_service.py"')
    WorkingDirectory = $taskRoot
    WindowStyle = 'Hidden'
    PassThru = $true
    RedirectStandardOutput = Join-Path $taskLogs 'stdout.log'
    RedirectStandardError = Join-Path $taskLogs 'stderr.log'
}
$taskProcess = Start-Process @taskArguments
$taskProcess.WaitForExit()
exit $(if ($taskProcess.ExitCode -eq 0) { 1 } else { $taskProcess.ExitCode })
