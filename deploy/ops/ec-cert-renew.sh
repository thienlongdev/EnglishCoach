#!/bin/sh
# Daily TLS certificate renewal (security closure 2026-10). Before this there was NO renewal job: the Let's Encrypt
# certificate would have expired on 2026-12-18. certbot renews only inside the last 30 days, over the HTTP-01 webroot
# Nginx already serves (/.well-known/acme-challenge/), with the account and renewal configuration that issued the
# certificate. Nginx is reloaded (not restarted) only when a new certificate was written.
. /root/english-coach/ops/ec-common.sh
cd "$EC_ROOT"
before=$(openssl x509 -noout -fingerprint -sha256 -in deploy/certbot/conf/live/englishcoach.io.vn/fullchain.pem 2>/dev/null || true)
if ! docker run --rm -v "$EC_ROOT/deploy/certbot/conf:/etc/letsencrypt" -v "$EC_ROOT/deploy/certbot/www:/var/www/certbot" \
        certbot/certbot:v5.8.0 renew --webroot -w /var/www/certbot --non-interactive --quiet; then
    ec_alert cert-renew-failed "Gia han chung chi TLS that bai. Het han: $(openssl x509 -noout -enddate -in deploy/certbot/conf/live/englishcoach.io.vn/fullchain.pem | cut -d= -f2)" 86400
    exit 1
fi
after=$(openssl x509 -noout -fingerprint -sha256 -in deploy/certbot/conf/live/englishcoach.io.vn/fullchain.pem 2>/dev/null || true)
if [ "$before" != "$after" ]; then
    docker exec english-coach-nginx-1 nginx -s reload && logger -t english-coach-ops "TLS certificate renewed, nginx reloaded"
fi
