# Is the right AI service answering on the GPU PC? Read-only; exit 0 only if everything holds (rules 10 §BE, §BM).
# Run after any Docker Desktop restart, Windows restart or Docker work. /health is not enough: an old rollback also answers 200 there.
param(
    [string]$Canonical = 'englishcoach-ai-whisperx',
    [string]$Pipeline = 'faster-whisper-large-v3+whisperx-wav2vec2',
    [string]$Base = 'http://127.0.0.1:8000'
)
$failed = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Output "PASS  $Name  $Detail" } else { Write-Output "FAIL  $Name  $Detail"; $script:failed++ }
}

$rows = docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'
$onPort = @($rows | Where-Object { $_ -match ':8000->8000' })
Check 'exactly one container publishes port 8000' ($onPort.Count -eq 1) ($onPort -join '; ')
Check 'it is the canonical one' ($onPort.Count -eq 1 -and $onPort[0].StartsWith("$Canonical|")) ($onPort -join '; ')

$obsolete = @(docker ps -a --format '{{.Names}}' | Where-Object { $_ -match '^docker-ai-service-' })
Check 'no obsolete AI container that a group Start could bring back' ($obsolete.Count -eq 0) ($obsolete -join ', ')

$restart = docker inspect $Canonical --format '{{.HostConfig.RestartPolicy.Name}}' 2>$null
Check 'restart policy' ($restart -eq 'unless-stopped') "$restart"
$mdd = docker inspect docker-mdd-service-1 --format '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' 2>$null
Check 'mdd-service running and restarting with the engine' ($mdd -eq 'running unless-stopped') "$mdd"

try {
    $cap = Invoke-RestMethod -Uri "$Base/api/v1/listening/capabilities" -TimeoutSec 10
    Check 'capability: pipeline id' ($cap.pipeline -eq $Pipeline) "$($cap.pipeline)"
    Check 'capability: large-v3 in GPU memory' ($cap.transcription.model -eq 'large-v3' -and $cap.transcription.loaded -and $cap.transcription.device -eq 'cuda') "$($cap.transcription.model) $($cap.transcription.device)"
    Check 'capability: alignment in GPU memory' ($cap.alignment.loaded -and $cap.alignment.device -eq 'cuda') "$($cap.alignment.engine) $($cap.alignment.device)"
    Check 'capability: ready' ([bool]$cap.ready)
} catch {
    Check 'capability route answers (an old rollback has none)' $false "$($_.Exception.Message)"
}

foreach ($url in @('http://127.0.0.1:8010/health', 'http://127.0.0.1:8000/api/v1/health')) {
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 8 -UseBasicParsing
        Check "AI health probe $url" ($r.StatusCode -eq 200)
    } catch {
        Check "AI health probe $url" $false "$($_.Exception.Message)"
    }
}

if ($failed -gt 0) { Write-Output "`n$failed check(s) failed. Recovery: deploy/ai/README.md"; exit 1 }
Write-Output "`nThe canonical WhisperX service is the one answering."
exit 0
