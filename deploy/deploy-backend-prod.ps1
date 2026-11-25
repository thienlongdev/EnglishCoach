param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VpsHost,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VpsUser,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RemoteProjectDirectory,
    [string]$SshKeyPath = "",
    # How long the new container may take to report "healthy" (start-up is about one minute) before this helper fails.
    [ValidateRange(60, 900)][int]$HealthTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
# Explicit targets only. SSH aliases are supported; no old-host/user/key defaults.
if ($VpsHost -notmatch '^[a-zA-Z0-9.-]+$' -or $VpsUser -notmatch '^[a-zA-Z0-9_-]+$' -or
    $RemoteProjectDirectory -notmatch '^/[a-zA-Z0-9_./-]+$' -or $RemoteProjectDirectory.Contains('..')) {
    throw "Invalid explicit SSH target or absolute remote project directory."
}
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
if ($SshKeyPath) {
    if (-not (Test-Path -LiteralPath $SshKeyPath -PathType Leaf)) { throw "SSH key path does not exist." }
    $sshOptions += @('-i', $SshKeyPath)
}
$service = 'backend'
$image = 'english-coach-backend:prod'
$compose = "docker compose --env-file .env.production -f docker-compose.prod.yml"
$recovery = "ssh $VpsUser@$VpsHost `"cd $RemoteProjectDirectory && $compose up -d --no-build --force-recreate $service`""

# Runs one native command and decides ONLY by its exit code.
# Docker, Compose and SSH write ordinary progress to stderr. Under Windows PowerShell 5.1 with
# $ErrorActionPreference = 'Stop', a stderr line of a native command becomes a TERMINATING error as soon as any caller
# redirects the stream (for example "deploy-backend-prod.ps1 2>&1"). On 2026-10-12 that ended the SSH session on
# Compose's first progress line ("Container ... Recreate"): the old backend was already removed, the new one was
# created but never started, and production was down for about two minutes. Here stderr is merged and printed as
# plain text with the preference relaxed for the duration of the call, so progress output can never abort the helper;
# a real failure is still caught, by the exit code.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command, [Parameter(Mandatory = $true)][string]$Failure)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message } else { Write-Host $_ }
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$Failure (exit code $code)" }
}

# Like Invoke-Native for a short remote query whose single line of output is the answer; never throws.
function Get-RemoteLine {
    param([Parameter(Mandatory = $true)][string]$RemoteCommand)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & ssh @sshOptions "$VpsUser@$VpsHost" $RemoteCommand 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return (@($lines) | Where-Object { $_ } | Select-Object -Last 1)
    } finally {
        $ErrorActionPreference = $previous
    }
}

$tarPath = Join-Path (Get-Location).Path 'english-coach-backend-prod.tar'
$expectedImage = (docker image inspect $image --format '{{.Id}}')
if ($LASTEXITCODE -ne 0 -or -not $expectedImage) { throw "Production image is missing." }
Invoke-Native { docker save -o $tarPath $image } "Image packaging failed."
$archiveHash = (Get-FileHash -LiteralPath $tarPath -Algorithm SHA256).Hash.ToLowerInvariant()
$remoteArchive = "$RemoteProjectDirectory/english-coach-backend-prod.tar"
Invoke-Native { scp @sshOptions $tarPath "$($VpsUser)@$($VpsHost):$remoteArchive" } "Image transfer failed. The running service was not touched."

# Step 1 of 3 - verify the archive and the loaded image BEFORE replacing the service. Keep archives as evidence.
# Nothing in this step touches the running container: a failure here leaves production exactly as it was.
$loadCmd = "set -eu; cd '$RemoteProjectDirectory'; echo '$archiveHash  $remoteArchive' | sha256sum -c -; docker load -i '$remoteArchive'; test `"`$(docker image inspect $image --format '{{.Id}}')`" = '$expectedImage'"
Invoke-Native { ssh @sshOptions "$VpsUser@$VpsHost" $loadCmd } "Remote archive check or image load failed. The running service was not touched."

# Step 2 of 3 - recreate the one service with the canonical Compose command. It runs under nohup with its output in
# a log file on the target, so a dropped SSH session or a dying local shell can no longer stop Compose between
# "remove the old container" and "start the new one".
$recreateCmd = "cd '$RemoteProjectDirectory' || exit 97; nohup $compose up -d --no-build --no-deps --force-recreate $service > deploy-$service-last.log 2>&1; rc=`$?; cat deploy-$service-last.log; exit `$rc"
try {
    Invoke-Native { ssh @sshOptions "$VpsUser@$VpsHost" $recreateCmd } "Compose recreation reported a failure."
} catch {
    Write-Host "[WARN] $($_.Exception.Message) Checking what is actually running before deciding." -ForegroundColor Yellow
}

# Step 3 of 3 - what is running is established by inspection, in fresh SSH sessions, whatever step 2 printed:
# the expected immutable image, a container that really started, and a passing health check.
# (no double quotes inside the remote command: Windows PowerShell 5.1 drops them when it passes the argument to ssh)
$inspectCmd = "cd '$RemoteProjectDirectory' && id=`$($compose ps -aq $service | head -n 1) && docker inspect `${id:?no-container} --format '{{.Image}}|{{.State.Status}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'"
$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
$state = $null
while ($true) {
    $state = Get-RemoteLine $inspectCmd
    if ($state) {
        $parts = $state.Split('|')
        $runningImage = $parts[0]; $status = $parts[1]; $startedAt = $parts[2]; $health = $parts[3]
        if ($runningImage -ne $expectedImage) {
            throw "A different image is running ($runningImage, expected $expectedImage). Inspect the target before retrying."
        }
        if ($status -eq 'created' -or $startedAt.StartsWith('0001-01-01')) {
            # exactly the 2026-10-12 state: created, never started. The canonical command starts it.
            Write-Host "[WARN] The new container exists but was never started; starting it with the canonical Compose command." -ForegroundColor Yellow
            Invoke-Native { ssh @sshOptions "$VpsUser@$VpsHost" "cd '$RemoteProjectDirectory' && nohup $compose up -d --no-build --no-deps $service > deploy-$service-last.log 2>&1; rc=`$?; cat deploy-$service-last.log; exit `$rc" } "The container could not be started. Recovery: $recovery"
        } elseif ($status -eq 'running' -and ($health -eq 'healthy' -or $health -eq 'none')) {
            break
        } elseif ($status -eq 'exited' -or $status -eq 'dead' -or $health -eq 'unhealthy') {
            throw "The new container is '$status' / health '$health'. Read its log (docker logs) on the target. Recovery: $recovery"
        }
        Write-Host "  waiting for health: status=$status health=$health"
    } else {
        Write-Host "  waiting: the target did not answer the inspection yet"
    }
    if ((Get-Date) -gt $deadline) {
        throw "The service did not become healthy within $HealthTimeoutSeconds s (last state: $state). Recovery: $recovery"
    }
    Start-Sleep -Seconds 5
}
Write-Host "[OK] $service runs the expected immutable image $expectedImage and its health check passes. Run the live canary gates before declaring the deployment complete." -ForegroundColor Green
