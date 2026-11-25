#!/bin/sh
# English Coach — persistent origin lock to Cloudflare. Run on the VPS as root, only after the domain is
# proxied by Cloudflare and verified (docs/performance/capacity-2026-10/CDN-ORIGIN-RUNBOOK.md §4).
#
#   sh ec-origin-allowlist.sh status      show what is installed (default)
#   sh ec-origin-allowlist.sh plan        print the rules it would install, change nothing
#   EC_CLOUDFLARE_PROXY_CONFIRMED=yes sh ec-origin-allowlist.sh apply
#   sh ec-origin-allowlist.sh remove      roll back: delete the rules, the site is open to everyone again
#
# What it does: new connections to the published web ports 80 and 443 that arrive on the public interface are accepted
# only from Cloudflare's published ranges; everything else is dropped. Tailscale uses its own interface. SSH (22),
# Tailscale, outgoing traffic (database, AI worker over Tailscale, mail, backups, certificate renewal) and the
# containers' own traffic are not touched. Docker publishes ports with DNAT, so IPv4 filtering must sit in DOCKER-USER
# (rules in INPUT never see that traffic); IPv6 reaches docker-proxy through INPUT.
#
# Persistence: ec-origin-allowlist.service restores before Docker; ec-origin-docker.conf restores after Docker starts.
# mangle PREROUTING guards BOTH address families before DNAT, including Docker's forwarding and userland proxy.
# Only the public interfaces are restricted; tailscale0, loopback, SSH and outbound replies are untouched.
# Activation requires a separate public Cloudflare check and a systemd automatic rollback timer (runbook).
set -eu
MARKER=/etc/english-coach-origin-enabled
# An installed Docker hook must remain harmless after emergency rollback, even before routes exist at boot.
if [ "${1:-status}" = restore ] && [ ! -f "$MARKER" ]; then exit 0; fi

CHAIN=EC-ORIGIN
V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20
188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
"
V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
"
IFACES=$({ ip -4 route show default; ip -6 route show default; } 2>/dev/null |
  awk '{for (i = 1; i < NF; i++) if ($i == "dev" && !seen[$(i+1)]++) print $(i+1)}')
[ -n "$IFACES" ] || { echo "no default route interface found" >&2; exit 1; }

status() {
  echo "public interfaces: $IFACES"
  for fw in iptables ip6tables; do
    "$fw" -w 10 -t mangle -S PREROUTING | grep "$CHAIN" || true
    "$fw" -w 10 -S INPUT | grep "$CHAIN" || true
    "$fw" -w 10 -S DOCKER-USER 2>/dev/null | grep "$CHAIN" || true
  done
  [ ! -f "$MARKER" ] || echo "persistent activation marker present"
}

plan() {
  echo "For IPv4 and IPv6 on $IFACES: ports 80/443, NEW connections only."
  echo "mangle PREROUTING (pre-DNAT), filter INPUT, and DOCKER-USER where present."
  echo "Cloudflare IPv4: $V4"
  echo "Cloudflare IPv6: $V6"
  echo "All other sources DROP; all other interfaces/ports/replies unchanged."
}

remove() {
  rm -f "$MARKER"
  systemctl disable ec-origin-allowlist.service >/dev/null 2>&1 || true
  for fw in iptables ip6tables; do
    for iface in $IFACES; do
      for p in 80 443; do
        while "$fw" -w 10 -t mangle -D PREROUTING -i "$iface" -p tcp --dport "$p" -m conntrack --ctstate NEW -j "$CHAIN" 2>/dev/null; do :; done
        while "$fw" -w 10 -D INPUT -i "$iface" -p tcp --dport "$p" -m conntrack --ctstate NEW -j "$CHAIN" 2>/dev/null; do :; done
        while "$fw" -w 10 -D DOCKER-USER -i "$iface" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" --ctdir ORIGINAL -j "$CHAIN" 2>/dev/null; do :; done
      done
    done
    for table in mangle filter; do
      "$fw" -w 10 -t "$table" -F "$CHAIN" 2>/dev/null && "$fw" -w 10 -t "$table" -X "$CHAIN" 2>/dev/null || true
    done
  done
  echo "removed"; status
}

apply() {
  [ "${EC_CLOUDFLARE_PROXY_CONFIRMED:-}" = yes ] || { echo "refusing: set EC_CLOUDFLARE_PROXY_CONFIRMED=yes after the runbook checks" >&2; exit 2; }
  # the public name must already answer through Cloudflare, or this would take the site off the internet
  # Explicit verified proxy address avoids a stale VPS resolver; supplied only after external DNS/range checks.
  [ -n "${EC_CLOUDFLARE_CONNECT_IP:-}" ] || { echo "refusing: verified EC_CLOUDFLARE_CONNECT_IP required" >&2; exit 2; }
  systemctl is-active --quiet ec-origin-rollback.timer || { echo "refusing: automatic rollback timer is not armed" >&2; exit 2; }
  server=$(curl -fsSI --max-time 15 --resolve "englishcoach.io.vn:443:$EC_CLOUDFLARE_CONNECT_IP" https://englishcoach.io.vn/ | tr -d '\r' | awk -F': ' 'tolower($1) == "server" {print tolower($2)}')
  [ "$server" = cloudflare ] || { echo "refusing: https://englishcoach.io.vn/ is not served through Cloudflare (server: ${server:-none})" >&2; exit 3; }
  iptables -S DOCKER-USER >/dev/null 2>&1 || { echo "refusing: DOCKER-USER chain missing (is Docker running?)" >&2; exit 4; }
  trap 'remove >/dev/null' 0
  install_rules
  touch "$MARKER"
  systemctl enable ec-origin-allowlist.service >/dev/null
  trap - 0
  echo "applied"; status
}

install_rules() {
  # Preflight both families before installing anything; IPv6 failure must never silently leave a bypass.
  iptables -w 10 -t mangle -S PREROUTING >/dev/null
  ip6tables -w 10 -t mangle -S PREROUTING >/dev/null
  for fw in iptables ip6tables; do
    ranges=$V4; [ "$fw" != ip6tables ] || ranges=$V6
    for table in mangle filter; do
      "$fw" -w 10 -t "$table" -N "$CHAIN" 2>/dev/null || "$fw" -w 10 -t "$table" -F "$CHAIN"
      for r in $ranges; do "$fw" -w 10 -t "$table" -A "$CHAIN" -s "$r" -j RETURN; done
      "$fw" -w 10 -t "$table" -A "$CHAIN" -j DROP
    done
    for iface in $IFACES; do
      for p in 80 443; do
        "$fw" -w 10 -t mangle -C PREROUTING -i "$iface" -p tcp --dport "$p" -m conntrack --ctstate NEW -j "$CHAIN" 2>/dev/null ||
          "$fw" -w 10 -t mangle -I PREROUTING 1 -i "$iface" -p tcp --dport "$p" -m conntrack --ctstate NEW -j "$CHAIN"
        "$fw" -w 10 -C INPUT -i "$iface" -p tcp --dport "$p" -m conntrack --ctstate NEW -j "$CHAIN" 2>/dev/null ||
          "$fw" -w 10 -I INPUT 1 -i "$iface" -p tcp --dport "$p" -m conntrack --ctstate NEW -j "$CHAIN"
        if "$fw" -w 10 -S DOCKER-USER >/dev/null 2>&1; then
          "$fw" -w 10 -C DOCKER-USER -i "$iface" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" --ctdir ORIGINAL -j "$CHAIN" 2>/dev/null ||
            "$fw" -w 10 -I DOCKER-USER 1 -i "$iface" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" --ctdir ORIGINAL -j "$CHAIN"
        fi
      done
    done
  done
}

case "${1:-status}" in
  status) status ;;
  plan) plan ;;
  apply) apply ;;
  restore) [ ! -f "$MARKER" ] || install_rules ;;
  remove) remove ;;
  *) echo "usage: $0 status|plan|apply|restore|remove" >&2; exit 64 ;;
esac
