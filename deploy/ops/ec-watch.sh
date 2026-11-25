#!/bin/sh
# Host watchdog, every five minutes (security closure 2026-10). Independent of the backend: it still alerts when the
# application is down. Each condition mails the owner at most once per six hours (ec_alert).
. /root/english-coach/ops/ec-common.sh
for svc in backend frontend nginx; do
    c="english-coach-$svc-1"
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.OOMKilled}}' "$c" 2>/dev/null || echo "missing - - -")
    set -- $state
    if [ "$1" != "running" ] || [ "$2" = "unhealthy" ]; then
        ec_alert "$svc-down" "Dich vu $svc: trang thai $1 / suc khoe $2."
    fi
    if [ "$4" = "true" ]; then ec_alert "$svc-oom" "Dich vu $svc bi het bo nho (OOMKilled)."; fi
    last=$(cat "$EC_STATE/restarts-$svc" 2>/dev/null || echo "$3")
    if [ "$3" != "-" ] && [ "$3" -gt "$last" ] 2>/dev/null; then ec_alert "$svc-restart" "Dich vu $svc tu khoi dong lai ($3 lan)." 3600; fi
    [ "$3" != "-" ] && echo "$3" > "$EC_STATE/restarts-$svc"
done
used=$(df --output=pcent / | tail -n 1 | tr -dc 0-9)
[ "$used" -ge 90 ] && ec_alert disk-full "O dia may chu da dung ${used}%."
end=$(openssl x509 -noout -enddate -in "$EC_ROOT/deploy/certbot/conf/live/englishcoach.io.vn/fullchain.pem" | cut -d= -f2)
days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
[ "$days" -lt 14 ] && ec_alert cert-expiry "Chung chi TLS con $days ngay (het han $end)."
if [ -f "$EC_STATE/last-backup" ]; then
    age=$(( $(date +%s) - $(date -d "$(cut -c1-8 "$EC_STATE/last-backup") $(cut -c10-11 "$EC_STATE/last-backup"):$(cut -c12-13 "$EC_STATE/last-backup")" +%s) ))
    [ "$age" -gt 108000 ] && ec_alert backup-stale "Ban sao luu CSDL gan nhat da cu hon 30 gio."
fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve englishcoach.io.vn:443:127.0.0.1 https://englishcoach.io.vn/api/v1/exams/capabilities || echo 000)
[ "$code" = "200" ] || ec_alert site-down "Trang https://englishcoach.io.vn tra ve $code cho kiem tra suc khoe."
exit 0
