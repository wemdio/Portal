#!/usr/bin/env bash
# Однократная (и повторяемая без вреда) установка read-only доступа к Signals RU.
# Запуск на 139.60.162.24 от root из каталога с файлами:
#   /opt/signals-ru-readonly/setup.sh
# Перед запуском положить публичный ключ читателя в /etc/signals-ru-readonly/signals_ro.pub
#
# Что делает:
#   1. пароли в /etc/signals-ru-readonly (0600), если их ещё нет;
#   2. поднимает контейнер signals-ru-readonly (127.0.0.1:35440);
#   3. база signals_ru, роль signals_ro: только SELECT, read-only транзакции;
#   4. Linux-пользователь signals-ro: без shell и пароля, ключ разрешает
#      только туннель к 127.0.0.1:35440;
#   5. cron каждые 15 минут + первая синхронизация.
# Сервис outreachos-ru не перезапускается и не меняется.
set -euo pipefail

DIR=/opt/signals-ru-readonly
ETC=/etc/signals-ru-readonly
INCOMING=/var/lib/signals-ru-readonly/incoming
CONTAINER=signals-ru-readonly
OS_USER=signals-ro
DB_ROLE=signals_ro
PORT=35440

[ "$(id -u)" = 0 ] || { echo "нужен root" >&2; exit 1; }
[ -s "$ETC/signals_ro.pub" ] || { echo "нет $ETC/signals_ro.pub" >&2; exit 1; }

umask 077
mkdir -p "$ETC" && chmod 700 "$ETC"
[ -s "$ETC/postgres.env" ] || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > "$ETC/postgres.env"
[ -s "$ETC/signals_ro.password" ] || openssl rand -hex 16 > "$ETC/signals_ro.password"
chmod 600 "$ETC/postgres.env" "$ETC/signals_ro.password"

umask 022
mkdir -p "$INCOMING" && chmod 755 /var/lib/signals-ru-readonly "$INCOMING"

echo "== контейнер"
docker compose -p signals-ru-readonly -f "$DIR/docker-compose.yml" up -d
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' $CONTAINER)" = healthy ] && break
  sleep 2
done
docker exec $CONTAINER pg_isready -h 127.0.0.1 -U postgres

psql_admin() { docker exec -i $CONTAINER psql -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "== база и роль"
psql_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='signals_ru'" | grep -q 1 \
  || psql_admin -d postgres -c "CREATE DATABASE signals_ru"
# пароль через stdin, чтобы не светился в списке процессов
psql_admin -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_ROLE') THEN
    CREATE ROLE $DB_ROLE LOGIN;
  END IF;
END \$\$;
ALTER ROLE $DB_ROLE WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5
  PASSWORD '$(cat "$ETC/signals_ro.password")';
ALTER ROLE $DB_ROLE SET default_transaction_read_only = on;
ALTER ROLE $DB_ROLE SET statement_timeout = '10min';
ALTER ROLE $DB_ROLE SET idle_in_transaction_session_timeout = '15min';
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
REVOKE ALL ON DATABASE signals_ru FROM PUBLIC;
GRANT CONNECT ON DATABASE signals_ru TO $DB_ROLE;
SQL
psql_admin -d signals_ru <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $DB_ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO $DB_ROLE;
SQL

echo "== пользователь для туннеля"
if ! id "$OS_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "$OS_USER"
fi
usermod -s /usr/sbin/nologin -p '*' "$OS_USER"   # '*' — вход по паролю невозможен, только ключ
HOME_DIR=$(getent passwd "$OS_USER" | cut -d: -f6)
install -d -m 700 -o "$OS_USER" -g "$OS_USER" "$HOME_DIR/.ssh"
# restrict — запрещает всё (pty, agent, X11, команды); port-forwarding + permitopen —
# только локальный проброс на порт базы; permitlisten на привилегированный порт
# фактически запрещает обратный проброс (-R).
printf 'restrict,port-forwarding,permitopen="127.0.0.1:%s",permitlisten="127.0.0.1:1" %s\n' \
  "$PORT" "$(cat "$ETC/signals_ro.pub")" > "$HOME_DIR/.ssh/authorized_keys"
chown "$OS_USER:$OS_USER" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

echo "== cron и первая синхронизация"
install -m 644 "$DIR/signals-ru-readonly.cron" /etc/cron.d/signals-ru-readonly
python3 "$DIR/sync.py" | tee -a /var/log/signals-ru-readonly-sync.log

echo "== готово. Пароль роль $DB_ROLE: $ETC/signals_ro.password"
