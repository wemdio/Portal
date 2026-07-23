"""
Loop watchdog for prod host (139).

Слушает docker events и защищает сервер от exit-loop контейнеров, которые
рестартуют раз в минуту и в перспективе десятков минут ломают docker daemon /
networkd (создание/удаление netns/veth в цикле → RCU stall → soft-hang ядра).

Такие висяки уже дважды роняли сервер:
  - 22.07.2026: postgrest healthcheck loop (15 часов до hang)
  - 23.07.2026 21:00 MSK: leads-report-bot exit loop (10 минут до hang)

Алгоритм:
  1. Стримим docker events с фильтром `event=die`.
  2. На каждый die добавляем timestamp в deque для этого container_name.
  3. Обрезаем deque до последних WINDOW_SEC секунд.
  4. Если в окне ≥ THRESHOLD событий:
       - docker update --restart=no <name>  (снимаем автостарт)
       - docker stop <name>                 (гасим)
       - TG-алерт с командой для восстановления
       - deque очищаем, чтобы не спамить

Не трогаем:
  - контейнеры с exit code 0 (штатное завершение)
  - контейнер самого watchdog'а
"""
from __future__ import annotations

import os
import sys
import time
from collections import defaultdict, deque
from typing import Deque

import docker
import requests
from docker.errors import APIError, DockerException, NotFound

WINDOW_SEC = int(os.environ.get("WATCHDOG_WINDOW_SEC", "600"))
THRESHOLD = int(os.environ.get("WATCHDOG_THRESHOLD", "5"))
SELF_NAME = os.environ.get("WATCHDOG_SELF_NAME", "portal-loop-watchdog")

TG_TOKEN = os.environ.get("TELEGRAM_HEALTH_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
TG_CHAT_ID = os.environ.get("TELEGRAM_HEALTH_CHAT_ID")

exits: dict[str, Deque[float]] = defaultdict(lambda: deque(maxlen=THRESHOLD * 4))


def log(msg: str) -> None:
    print(f"[loop-watchdog] {msg}", flush=True)


def send_tg(text: str) -> None:
    if not TG_TOKEN or not TG_CHAT_ID:
        log("TG creds missing, skipping alert")
        return
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "Markdown", "disable_web_page_preview": True},
            timeout=10,
        )
        if r.status_code >= 300:
            log(f"TG error {r.status_code}: {r.text[:200]}")
    except Exception as e:  # noqa: BLE001
        log(f"TG exception: {e}")


def kill_loop(client: docker.DockerClient, name: str, count: int) -> None:
    try:
        c = client.containers.get(name)
    except NotFound:
        log(f"{name}: container gone, skip")
        return
    log(f"KILLING {name}: {count} exits in {WINDOW_SEC}s")
    err_parts = []
    try:
        c.update(restart_policy={"Name": "no"})
    except APIError as e:
        err_parts.append(f"update: {e}")
    try:
        c.stop(timeout=5)
    except APIError as e:
        err_parts.append(f"stop: {e}")
    err_note = f"\n\n⚠️ Ошибки при остановке: {'; '.join(err_parts)}" if err_parts else ""
    send_tg(
        f"🚨 *LOOP WATCHDOG*\n\n"
        f"Контейнер `{name}` упал *{count}* раз за {WINDOW_SEC // 60} мин "
        f"— это exit-loop, который через 10–20 минут повесит сервер "
        f"(история: postgrest 22.07, leads-report-bot 23.07).\n\n"
        f"Контейнер принудительно остановлен, restart policy сброшен на `no`.\n\n"
        f"*Портал и остальные сервисы работают.*\n\n"
        f"Чтобы восстановить после починки:\n"
        f"```\ndocker update --restart=unless-stopped {name}\n"
        f"docker start {name}\n```"
        f"{err_note}"
    )


def handle_die(client: docker.DockerClient, event: dict) -> None:
    attrs = event.get("Actor", {}).get("Attributes", {}) or {}
    name = attrs.get("name") or ""
    if not name or name == SELF_NAME:
        return
    exit_code = attrs.get("exitCode", "")
    if exit_code == "0":
        exits.pop(name, None)
        return
    now = time.time()
    dq = exits[name]
    dq.append(now)
    while dq and dq[0] < now - WINDOW_SEC:
        dq.popleft()
    if len(dq) >= THRESHOLD:
        kill_loop(client, name, len(dq))
        exits.pop(name, None)


def main() -> int:
    log(
        f"starting; window={WINDOW_SEC}s threshold={THRESHOLD} "
        f"self={SELF_NAME} tg={'yes' if TG_TOKEN and TG_CHAT_ID else 'no'}"
    )
    while True:
        try:
            client = docker.from_env()
            client.ping()
            for event in client.events(decode=True, filters={"event": "die"}):
                handle_die(client, event)
        except DockerException as e:
            log(f"docker disconnected ({e}); retry in 5s")
            time.sleep(5)
        except Exception as e:  # noqa: BLE001
            log(f"unexpected: {e}; retry in 10s")
            time.sleep(10)


if __name__ == "__main__":
    sys.exit(main() or 0)
