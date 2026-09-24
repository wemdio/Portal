#!/bin/sh
# Собирает docker-compose.yml «Рассылки» для ЭТОГО сервера из SENDER_EGRESS_IPS
# в .env: на каждый адрес — воркер (extends worker.base.yml) и сеть, чей
# исходящий NAT привязан к адресу (com.docker.network.host_ipv4). Весь трафик
# воркера — SMTP, IMAP, Google — выходит с его адреса без участия кода.
#
# Адрес, которого нет на интерфейсах сервера, — ошибка: воркер такого адреса
# выходил бы в интернет не оттуда, где закреплены его ящики.
#
# Деплой зовёт это сам (Semaphore scheduled-deploy). Руками, в /opt/portal-sender:
#   sh render-compose.sh .env > docker-compose.yml
#   docker compose -p portal-sender --env-file .env pull
#   docker compose -p portal-sender --env-file .env up -d --remove-orphans
set -eu

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "render-compose: нет $ENV_FILE" >&2; exit 1; }

ips=$(grep -E '^SENDER_EGRESS_IPS=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d "\"' \r" | tr ',' ' ')
[ -n "$ips" ] || { echo "render-compose: SENDER_EGRESS_IPS пуст в $ENV_FILE" >&2; exit 1; }

host_ips=$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1)
seen=" "
for ip in $ips; do
  echo "$ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo "render-compose: «$ip» — не IPv4" >&2; exit 1; }
  echo "$host_ips" | grep -qx "$ip" || { echo "render-compose: адреса $ip нет на интерфейсах сервера" >&2; exit 1; }
  case "$seen" in *" $ip "*) echo "render-compose: $ip указан дважды" >&2; exit 1 ;; esac
  seen="$seen$ip "
done

cat <<'EOF'
# СГЕНЕРИРОВАНО deploy/sender/render-compose.sh из SENDER_EGRESS_IPS (.env).
# Руками не править: следующий деплой перезапишет.
services:
  # Перезапускает воркер, чей healthcheck (heartbeat-файл) протух: процесс жив,
  # а event loop мёртв. Сети ему не нужно — только docker.sock.
  autoheal:
    image: willfarrell/autoheal:1.2.0
    environment:
      - AUTOHEAL_CONTAINER_LABEL=autoheal
      - AUTOHEAL_INTERVAL=30
      - AUTOHEAL_START_PERIOD=180
      - DOCKER_SOCK=/var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    network_mode: none
    deploy:
      resources:
        limits:
          memory: 64M
          cpus: '0.1'
          pids: 512
    restart: unless-stopped
EOF

for ip in $ips; do
  slug=$(echo "$ip" | tr . -)
  cat <<EOF
  worker-$slug:
    extends:
      file: worker.base.yml
      service: worker
    environment:
      - SENDER_EGRESS_IP=$ip
    networks:
      - egress-$slug
EOF
done

echo "networks:"
for ip in $ips; do
  slug=$(echo "$ip" | tr . -)
  cat <<EOF
  egress-$slug:
    driver: bridge
    driver_opts:
      com.docker.network.host_ipv4: "$ip"
EOF
done
