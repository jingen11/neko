#!/usr/bin/env bash
# Install and start neko's systemd services. Run with sudo:
#   sudo ./deploy/install-services.sh
set -euo pipefail
cd "$(dirname "$0")/systemd"
for unit in neko-stt.service neko-voicevox.service neko.service; do
  install -m 644 "$unit" "/etc/systemd/system/$unit"
  echo "installed /etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now neko-stt.service neko-voicevox.service neko.service
systemctl --no-pager --lines=0 status neko-stt.service neko-voicevox.service neko.service || true
