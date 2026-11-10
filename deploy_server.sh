#!/usr/bin/env bash
# Сервер командной игры «Хвосты» на spacecode.business: /opt/tails-game, systemd tails-game (127.0.0.1:8841, QUIET=1 — ники не пишутся в журнал),
# nginx: https://spacecode.business/tails/play/ → игра, /tails/play/ws → WebSocket. Повторный запуск безопасен.
set -euo pipefail
cd "$(dirname "$0")"; H=root@144.91.83.27
rsync -a --delete --exclude node_modules --exclude android --exclude store --exclude tools --exclude docs --exclude .data ./ $H:/opt/tails-game/
ssh $H 'set -e; cd /opt/tails-game && npm install --omit=dev --no-audit --no-fund -q
cat > /etc/systemd/system/tails-game.service <<U
[Unit]
Description=Tails co-op game server
After=network.target
[Service]
WorkingDirectory=/opt/tails-game
Environment=PORT=8841 HOST=127.0.0.1 QUIET=1 DATA_DIR=/var/lib/tails-game
StateDirectory=tails-game
ExecStart=/usr/bin/node server/index.js
Restart=always
User=www-data
StandardOutput=null
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload; systemctl enable tails-game; systemctl restart tails-game
C=/etc/nginx/sites-enabled/spacecode.business
# откат неудачной вставки 05.11 (блок попал внутрь location /prodit/connection/)
if grep -q "tails/play" $C && ! nginx -t 2>/dev/null; then cp "$(ls -t /root/spacecode.business.nginx.bak-* | head -1)" $C; fi
# 05.11: порт 8795 на сервере занят gunicorn — переносим на 8841
sed -i "/tails\/play/s#127.0.0.1:8795#127.0.0.1:8841#" $C
if ! grep -q "tails/play" $C; then
  cp $C /root/spacecode.business.nginx.bak-$(date +%s)
  python3 - "$C" <<PY
import sys
p=sys.argv[1]; s=open(p).read()
blk="""
    location /tails/play/ws { proxy_pass http://127.0.0.1:8841/ws; proxy_http_version 1.1; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 3600s; access_log off; }
    location /tails/play/ { proxy_pass http://127.0.0.1:8841/; proxy_http_version 1.1; }
"""
a="index index.html;"; k=s.index(a)+len(a)   # сразу после index в первом server (443)
s=s[:k]+blk+s[k:]
open(p,"w").write(s)
PY
fi
# 1.14: радио — mp3 из админки до 30 МБ (у /tails/play/ действует nginx-умолчание 1 МБ): отдельный location для /api/admin/
if ! grep -q "tails/play/api/admin" $C; then
  cp $C /root/spacecode.business.nginx.bak-$(date +%s)
  sed -i "s#^\(\s*\)location /tails/play/ { proxy_pass http://127.0.0.1:8841/; proxy_http_version 1.1; }#&\n\1location /tails/play/api/admin/ { proxy_pass http://127.0.0.1:8841/api/admin/; proxy_http_version 1.1; client_max_body_size 32m; proxy_request_buffering off; proxy_read_timeout 300s; }#" $C
fi
nginx -t && systemctl reload nginx'
sleep 1
curl -s -o /dev/null -w "игра: %{http_code}\n" https://spacecode.business/tails/play/
curl -s https://spacecode.business/tails/play/healthz; echo
