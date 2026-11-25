#!/bin/sh
# Nightly encrypted database backup (security closure 2026-10).
#  - pg_dump (custom format) of the production database over TLS with the server certificate AND host name
#    verified (sslmode=verify-full against the host's CA bundle);
#  - the plain dump is read back completely (pg_restore to /dev/null) before it counts;
#  - it is encrypted for the owner's backup certificate (CMS, AES-256-GCM, RSA-OAEP) and the plain file is deleted;
#  - the encrypted file joins a hash chain and waits in /root/english-coach/offhost/db for the off-host pull;
#  - seven encrypted dumps are kept here; release backups under backups/ are never touched.
. /root/english-coach/ops/ec-common.sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$EC_STATE/backup-$stamp"
mkdir -p "$work"
# whatever stops this job (dump, read-back, encryption), the plain dump is deleted and the owner is told
trap 'rc=$?; rm -rf "$work"; [ "$rc" -eq 0 ] || ec_alert backup-failed "Sao luu CSDL hang dem THAT BAI ($stamp, ma $rc)." 3600' EXIT
url=$(ec_env DB_URL); url=${url#jdbc:postgresql://}
hostport=${url%%/*}; rest=${url#*/}; db=${rest%%\?*}
host=${hostport%%:*}; port=${hostport#*:}; [ "$port" = "$hostport" ] && port=5432
db_user=$(ec_env DB_USER)
if ! PGPASSWORD="$(ec_env DB_PASSWORD)" \
        PGHOST="$host" \
        PGPORT="$port" \
        PGDATABASE="$db" \
        PGUSER="$db_user" \
        PGSSLMODE="verify-full" \
        PGSSLROOTCERT="/ca.crt" \
        docker run --rm --network host \
            -e PGPASSWORD -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGSSLMODE -e PGSSLROOTCERT \
            -v "$work:/out" \
            -v /etc/ssl/certs/ca-certificates.crt:/ca.crt:ro \
            postgres:17 sh -c 'pg_dump -Fc --no-owner --no-acl -f /out/db.dump && pg_restore -f /dev/null /out/db.dump' ; then
    exit 1
fi
out="$EC_OUT/db/ec-db-$stamp.dump.cms"
ec_encrypt "$work/db.dump" "$out"
size=$(stat -c %s "$work/db.dump")
ec_chain "$EC_OUT/db" "$out"
echo "$stamp $size" > "$EC_STATE/last-backup"
# keep the newest seven encrypted dumps
ls -1t "$EC_OUT"/db/ec-db-*.dump.cms 2>/dev/null | tail -n +8 | while read -r old; do rm -f -- "$old"; done
logger -t english-coach-ops "backup $stamp ok ($size bytes plain, encrypted)" 2>/dev/null || true
