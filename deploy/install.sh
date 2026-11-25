#!/usr/bin/env bash
# Sets up a Chronark Cloud node on a fresh Ubuntu 22.04/24.04 server that runs nothing else.
# Run as root:  DOMAIN=api.example.com bash deploy/install.sh
# Strangers' code will run on this machine (inside locked-down containers). Do not use a server that hosts other sites.
set -euo pipefail
: "${DOMAIN:?set DOMAIN to the hostname that points at this server, e.g. DOMAIN=api.chronark.cloud}"
REPO_DIR=/opt/chronark
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https ufw

# Docker (official repo)
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io
fi

# Node.js 22 (NodeSource)
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy for HTTPS
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# Service user: may talk to Docker, nothing else
id chronark >/dev/null 2>&1 || useradd --system --home /var/lib/chronark --create-home --shell /usr/sbin/nologin chronark
usermod -aG docker chronark

[ -d "$REPO_DIR/.git" ] || git clone https://github.com/chronarklabs/chronark.git "$REPO_DIR"
git -C "$REPO_DIR" pull --ff-only

for img in alpine:3.20 python:3.12-slim node:22-slim; do docker pull -q "$img"; done

install -m 0644 "$REPO_DIR/deploy/chronark.service" /etc/systemd/system/chronark.service
sed "s/{DOMAIN}/$DOMAIN/" "$REPO_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile

ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

systemctl daemon-reload
systemctl enable --now chronark
systemctl reload caddy || systemctl restart caddy

sleep 2
curl -fsS http://127.0.0.1:8787/v1/node && echo
echo "Done. Public API: https://$DOMAIN  (logs: journalctl -u chronark -f)"
echo "Fund an account: sudo -u chronark CHRONARK_DATA=/var/lib/chronark node $REPO_DIR/server/main.js credit <account> <USDC>"
