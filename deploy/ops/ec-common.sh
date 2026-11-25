#!/bin/sh
# Shared helpers of the English Coach host jobs (security closure 2026-10). Sourced, never run directly.
# Reads values from the production environment file without printing them.
set -eu
EC_ROOT=/root/english-coach
EC_ENV="$EC_ROOT/.env.production"
EC_OPS="$EC_ROOT/ops"
EC_STATE="$EC_OPS/state"
EC_OUT="$EC_ROOT/offhost"          # encrypted files waiting for the off-host pull (owner's PC over SSH)
EC_RECIPIENT="$EC_OPS/backup-recipient.cert.pem"   # public certificate only; the private key never lives here
umask 077
mkdir -p "$EC_STATE" "$EC_OUT/db" "$EC_OUT/logs"

# Value of KEY in the environment file (first match, surrounding quotes removed). Never echo the result.
ec_env() {
    sed -n "s/^$1=//p" "$EC_ENV" | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Encrypts $1 to $2 for the backup recipient (CMS, AES-256-GCM content key wrapped with RSA-OAEP).
ec_encrypt() {
    openssl cms -encrypt -binary -aes-256-gcm -recip "$EC_RECIPIENT" -keyopt rsa_padding_mode:oaep -in "$1" -outform DER -out "$2"
}

# Appends "<utc> <sha256> <file>" to the hash chain of a directory: each line also carries the hash of the line
# before, so a removed or edited entry breaks the chain the off-host copy can check.
ec_chain() {
    dir=$1; file=$2
    prev=$(tail -n 1 "$dir/CHAIN" 2>/dev/null | awk '{print $NF}')
    [ -n "$prev" ] || prev=genesis
    sum=$(sha256sum "$file" | cut -c1-64)
    t=$(date -u +%FT%TZ)
    link=$(printf '%s %s %s %s' "$t" "$sum" "$(basename "$file")" "$prev" | sha256sum | cut -c1-64)
    printf '%s %s %s %s\n' "$t" "$sum" "$(basename "$file")" "$link" >> "$dir/CHAIN"
}

# Strips CR and LF from single-line header/credential values to prevent SMTP header or netrc injection.
ec_strip_crlf() {
    printf '%s' "$1" | tr -d '\r\n'
}

# Mails a short alert through the application's own SMTP account. Text only: never a secret or learner data.
# Deduplicated per key for $3 seconds (default 6 hours).
ec_alert() {
    key=$(ec_strip_crlf "$1"); text=$2; quiet=${3:-21600}
    safe_key=$(printf '%s' "$key" | tr -cd 'A-Za-z0-9._-')
    [ -n "$safe_key" ] || safe_key=alert
    stamp="$EC_STATE/alert-$safe_key"
    now=$(date +%s)
    if [ -f "$stamp" ] && [ $((now - $(cat "$stamp"))) -lt "$quiet" ]; then return 0; fi
    echo "$now" > "$stamp"
    logger -t english-coach-ops "ALERT $key: $text" 2>/dev/null || true
    to=$(ec_strip_crlf "$(ec_env APP_SECURITY_ALERT_EMAIL)")
    host=$(ec_strip_crlf "$(ec_env MAIL_HOST)")
    port=$(ec_strip_crlf "$(ec_env MAIL_PORT)")
    user=$(ec_strip_crlf "$(ec_env MAIL_USERNAME)")
    from=$(ec_strip_crlf "$(ec_env MAIL_USERNAME)")
    [ -n "$to" ] && [ -n "$host" ] || return 0
    [ -n "$port" ] || port=587
    scheme=smtp; [ "$port" = "465" ] && scheme=smtps
    # Run temp-file creation and curl in a subshell with its own signal/exit trap so plaintext SMTP credentials
    # in netrc are always removed without clobbering the caller's EXIT trap.
    (
        msg=""
        netrc=""
        trap 'rm -f ${msg:+"$msg"} ${netrc:+"$netrc"}' EXIT INT TERM HUP
        msg=$(mktemp "$EC_STATE/mail.XXXXXX")
        netrc=$(mktemp "$EC_STATE/netrc.XXXXXX")
        chmod 600 "$msg" "$netrc"
        {
            printf 'From: English Coach Ops <%s>\r\nTo: %s\r\n' "$from" "$to"
            printf 'Subject: [English Coach] Canh bao may chu: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' "$key"
            printf '%s\r\n\r\nThoi diem (UTC): %s\r\nMay chu: %s\r\nThu nay khong chua mat khau, ma hay du lieu hoc vien.\r\n' "$text" "$(date -u +%FT%TZ)" "${EC_HOST_LABEL:-$(hostname)}"
        } > "$msg"
        # credentials go to curl through a 0600 mktemp netrc file, never on the command line
        pass=$(ec_strip_crlf "$(ec_env MAIL_PASSWORD)")
        printf 'machine %s login %s password %s\n' "$host" "$user" "$pass" > "$netrc"
        curl -sS --max-time 30 --ssl-reqd --url "$scheme://$host:$port" --netrc-file "$netrc" \
            --mail-from "$from" --mail-rcpt "$to" --upload-file "$msg" >/dev/null 2>&1 \
            || logger -t english-coach-ops "alert mail for $key not delivered" 2>/dev/null || true
    )
}
