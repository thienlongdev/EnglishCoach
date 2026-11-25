#!/bin/sh
# Hourly security log export (security closure 2026-10). A container's log disappears when the container is
# recreated by a release, so every hour the new lines of the three services are collected, compressed, encrypted
# for the owner's backup certificate and chained by hash, then pulled off the host by the owner's PC.
# The logs carry masked e-mail addresses, client addresses and request lines without query strings (Nginx format
# ec_access); never tokens, cookies, codes or learner text (application log rules, 10-rules §T).
# Fourteen days of exports are kept here.
. /root/english-coach/ops/ec-common.sh
since_file="$EC_STATE/logs-since"
since=$(cat "$since_file" 2>/dev/null || date -u -d '-1 hour' +%FT%TZ)
until=$(date -u +%FT%TZ)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$EC_STATE/logs-$stamp"
mkdir -p "$work"
trap 'rc=$?; rm -rf "$work"; [ "$rc" -eq 0 ] || ec_alert logs-export-failed "Xuat nhat ky may chu THAT BAI ($stamp, ma $rc)." 21600' EXIT
for svc in backend frontend nginx; do
    docker logs --since "$since" --until "$until" "english-coach-$svc-1" > "$work/$svc.log" 2>&1 || true
done
# audit trail of the host itself: who logged in over SSH, what cron ran
journalctl --since "$(date -d "$since" '+%F %T')" --until "$(date -d "$until" '+%F %T')" -u ssh -t english-coach-ops \
    --no-pager > "$work/host.log" 2>/dev/null || true
tar -C "$work" -czf "$work/bundle.tgz" backend.log frontend.log nginx.log host.log
out="$EC_OUT/logs/ec-logs-$stamp.tgz.cms"
ec_encrypt "$work/bundle.tgz" "$out"
ec_chain "$EC_OUT/logs" "$out"
echo "$until" > "$since_file"
find "$EC_OUT/logs" -name 'ec-logs-*.tgz.cms' -mtime +14 -delete
