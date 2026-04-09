#!/usr/bin/env bash
# Run on the PRODUCTION HOST (not inside Docker) to block outgoing SMTP
# connections from the server IP, preventing Spamhaus blacklisting.
#
# Usage:  sudo bash scripts/block-smtp-outbound.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

RULE="-A OUTPUT -p tcp --dport 25 -j DROP"

if iptables -C OUTPUT -p tcp --dport 25 -j DROP 2>/dev/null; then
  echo "iptables: outbound port 25 already blocked"
else
  iptables $RULE
  echo "iptables: outbound port 25 is now blocked"
fi

# Persist across reboots (Debian/Ubuntu)
if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save
  echo "Rule saved via netfilter-persistent"
elif command -v iptables-save &>/dev/null; then
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || \
  iptables-save > /etc/iptables.rules 2>/dev/null || \
  echo "WARNING: Could not persist rules automatically. Run: iptables-save > /etc/iptables.rules"
fi

echo "Done. Verify with: iptables -L OUTPUT -n | grep 'dpt:25'"
