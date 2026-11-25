<#
  Off-host copy of English Coach backups and security logs (security closure 2026-10). Runs on the owner's PC as the
  scheduled task "EnglishCoach Offhost Pull" (every two hours while the PC is on). It copies the ENCRYPTED files the
  VPS prepares in /root/english-coach/offhost/{db,logs} over SSH, checks every file against the VPS hash chain
  (a removed or altered entry breaks the chain) and keeps them under C:\Users\<user>\EnglishCoachBackups.
  Nothing here can decrypt: the private key (keys\backup-recipient.key.pem) should be moved to offline storage by the
  owner; restore instructions are in docs/operations/deployment-and-recovery.md.
#>
param(
    [string]$VpsHost = $env:EC_VPS_HOST,
    [string]$VpsUser = 'root',
    [string]$Target = (Join-Path $env:USERPROFILE 'EnglishCoachBackups')
)
$ErrorActionPreference = 'Stop'

function Test-OffhostArchiveName {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($Kind -eq 'db') {
        return $Name -cmatch '^ec-db-[0-9]{8}T[0-9]{6}Z\.dump\.cms$'
    }
    if ($Kind -eq 'logs') {
        return $Name -cmatch '^ec-logs-[0-9]{8}T[0-9]{6}Z\.tgz\.cms$'
    }
    return $false
}

function Test-OffhostDestinationPath {
    param(
        [Parameter(Mandatory = $true)][string]$LocalDir,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($Name.Contains('..') -or $Name.Contains('/') -or $Name.Contains('\') -or $Name.Contains(':')) {
        return $false
    }
    $root = [System.IO.Path]::GetFullPath($LocalDir).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    $destFull = [System.IO.Path]::GetFullPath((Join-Path $LocalDir $Name))
    $partFull = [System.IO.Path]::GetFullPath("$destFull.part")
    return $destFull.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) `
        -and $partFull.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-OffhostChain {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [AllowEmptyCollection()][string[]]$RemoteLines,
        [AllowEmptyCollection()][string[]]$ExistingLines = @()
    )
    if ($RemoteLines.Count -lt $ExistingLines.Count) {
        return [pscustomobject]@{ Valid = $false; Reason = "CHAIN TRUNCATED ($($RemoteLines.Count) < $($ExistingLines.Count))" }
    }
    for ($i = 0; $i -lt $ExistingLines.Count; $i++) {
        if ($RemoteLines[$i] -cne $ExistingLines[$i]) {
            return [pscustomobject]@{ Valid = $false; Reason = "CHAIN REWRITTEN at line $($i + 1)" }
        }
    }
    $prev = 'genesis'
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($line in $RemoteLines) {
            $p = $line.Split(' ')
            if ($p.Count -ne 4) {
                return [pscustomobject]@{ Valid = $false; Reason = "CHAIN MALFORMED ENTRY" }
            }
            if ($p[0] -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$') {
                return [pscustomobject]@{ Valid = $false; Reason = "CHAIN INVALID TIMESTAMP" }
            }
            if ($p[1] -cnotmatch '^[0-9a-f]{64}$' -or $p[3] -cnotmatch '^[0-9a-f]{64}$') {
                return [pscustomobject]@{ Valid = $false; Reason = "CHAIN INVALID HASH FORMAT" }
            }
            if (-not (Test-OffhostArchiveName -Kind $Kind -Name $p[2])) {
                return [pscustomobject]@{ Valid = $false; Reason = "CHAIN INVALID ARCHIVE NAME: $($p[2])" }
            }
            $text = "$($p[0]) $($p[1]) $($p[2]) $prev"
            $bytes = [Text.Encoding]::UTF8.GetBytes($text)
            $calc = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
            if ($calc -cne $p[3]) {
                return [pscustomobject]@{ Valid = $false; Reason = "CHAIN BROKEN at $($p[2])" }
            }
            $prev = $p[3]
        }
    } finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{ Valid = $true; Reason = $null }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($VpsUser -cnotmatch '^[a-zA-Z0-9._-]+$' -or $VpsHost -cnotmatch '^[a-zA-Z0-9._:-]+$') {
        throw "Refusing unsafe SSH target parameters"
    }
    $ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    $log = Join-Path $Target 'pull.log'
    function Note([string]$text) { Add-Content -LiteralPath $log -Value ("{0:u} {1}" -f (Get-Date).ToUniversalTime(), $text) }

    foreach ($kind in 'db', 'logs') {
        $local = Join-Path $Target $kind
        New-Item -ItemType Directory -Force -Path $local | Out-Null
        $chainRemote = "/root/english-coach/offhost/$kind/CHAIN"
        $chain = & ssh @ssh "$VpsUser@$VpsHost" "cat $chainRemote 2>/dev/null"
        if ($LASTEXITCODE -ne 0) { Note "${kind}: VPS not reachable"; continue }
        $lines = @($chain | Where-Object { $_ })
        $localChainPath = Join-Path $local 'CHAIN'
        $existingLines = if (Test-Path -LiteralPath $localChainPath) {
            @(Get-Content -LiteralPath $localChainPath | Where-Object { $_ })
        } else {
            @()
        }

        $check = Test-OffhostChain -Kind $kind -RemoteLines $lines -ExistingLines $existingLines
        if (-not $check.Valid) {
            Note "${kind}: $($check.Reason) — refusing local CHAIN overwrite and pull"
            continue
        }
        Set-Content -LiteralPath $localChainPath -Value $lines

        foreach ($line in $lines) {
            $p = $line.Split(' ')
            $name = $p[2]; $sum = $p[1]
            if (-not (Test-OffhostArchiveName -Kind $kind -Name $name) -or -not (Test-OffhostDestinationPath -LocalDir $local -Name $name)) {
                Note "${kind}: rejected unsafe archive path $name"
                continue
            }
            $dest = [System.IO.Path]::GetFullPath((Join-Path $local $name))
            $destPart = "$dest.part"
            if (Test-Path -LiteralPath $dest) { continue }
            & scp @ssh -q "$($VpsUser)@$($VpsHost):/root/english-coach/offhost/$kind/$name" $destPart
            if ($LASTEXITCODE -ne 0) { Note "${kind}: $name not available on the VPS any more"; Remove-Item -LiteralPath $destPart -ErrorAction SilentlyContinue; continue }
            $got = (Get-FileHash -LiteralPath $destPart -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($got -cne $sum) { Note "${kind}: $name HASH MISMATCH, discarded"; Remove-Item -LiteralPath $destPart; continue }
            Move-Item -LiteralPath $destPart -Destination $dest
            Note "${kind}: $name copied ($((Get-Item -LiteralPath $dest).Length) bytes, sha256 ok)"
        }
    }
    # retention on this PC: 30 database dumps, 90 days of logs
    Get-ChildItem -LiteralPath (Join-Path $Target 'db') -Filter 'ec-db-*.dump.cms' | Sort-Object Name -Descending | Select-Object -Skip 30 | Remove-Item
    Get-ChildItem -LiteralPath (Join-Path $Target 'logs') -Filter 'ec-logs-*.tgz.cms' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item
}
