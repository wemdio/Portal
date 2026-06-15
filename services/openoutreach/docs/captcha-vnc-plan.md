# CAPTCHA / VNC recovery — состояние и план

Статус: **частично**. Блокер «свежий аккаунт не пройти checkpoint» закрыт НЕ
полностью. Ниже — что сделано и что осталось (делать на dogfood-аккаунте с
живым браузером, вслепую опасно).

## Почему сейчас не работает (по построению)

1. `browser_session` запускал Chromium `headless=True` и **эфемерно**: на любом
   исключении (включая `CaptchaDetected`) контекст и браузер закрываются. Даже
   если бы VNC работал, оператор видел бы пустой Xvfb — решать нечего.
2. noVNC `:6080` не публиковался наружу, nginx-роута `/openoutreach-vnc/` нет.
3. `resume-from-captcha` лишь флипает `status='running'` → демон открывает
   НОВЫЙ headless-браузер, логинится заново → тот же `/checkpoint` → цикл.

## Что уже сделано (этот заход, 2026-06-12)

- `browser_session.py`: `headless` управляется env `LI2_BROWSER_HEADLESS`
  (default `true`). `LI2_BROWSER_HEADLESS=false` → Chromium рисует на Xvfb :99,
  который шарит x11vnc.
- `docker-compose.prod.yml`: сервис `openoutreach` публикует `127.0.0.1:6080:6080`
  и принимает `LI2_BROWSER_HEADLESS`.

Этого достаточно, чтобы **видеть** браузер через VNC, но НЕ чтобы решать
checkpoint — браузер всё ещё закрывается на `CaptchaDetected`.

## Что осталось (TODO, на dogfood)

### 1. Keep-alive пауза на checkpoint (код, главный кусок)

Сейчас `CaptchaDetected` пробрасывается из `execute_task` наружу из
`async with browser_session(...)` → браузер закрывается. Нужно перехватывать
checkpoint **внутри** scope сессии и держать страницу открытой, пока оператор
не решит капчу:

- В `account_worker._run` при `CaptchaDetected` НЕ выходить из `browser_session`,
  а: флипнуть `status='needs_captcha'`, затем поллить `Account.status` (раз в
  ~5s) пока он не станет `running` (оператор решил + дёрнул resume) или не
  истечёт таймаут (например, 15 мин) → тогда `disconnected`.
- На время паузы **освободить** `_BROWSER_SEMAPHORE` (иначе один застрявший на
  капче аккаунт заблокирует слоты остальных). Вариант: вынести captcha-pending
  браузеры в отдельный лимит, либо `acquire/release` вручную вокруг паузы.
- После resume — **reload** страницы (а не новый login): проверить, что
  checkpoint пройден (`_detect_blockers` чисто), сохранить `storage_state`
  (см. п.2), продолжить задачу.
- Требует `LI2_BROWSER_HEADLESS=false`, иначе на VNC пусто.

### 2. Сохранять storage_state ПОСЛЕ решения капчи

Сейчас на исключении state не сохраняется (browser_session.py:98-105 —
«на CAPTCHA/AuthError НЕ сохраняем»). Это правильно для битого state, но после
успешного решения капчи cookies валидны и их НУЖНО сохранить, иначе следующий
task снова упрётся в checkpoint. В keep-alive ветке после успешного reload —
явный `_save_storage_state`.

### 3. nginx на хосте 139 (инфра, руками)

`location /openoutreach-vnc/` с basic-auth → `proxy_pass http://127.0.0.1:6080/`
(WebSocket upgrade). Сниппет — в `services/openoutreach/CLAUDE.md`. nginx
site-конфиги CI НЕ деплоит (scheduled-deploy копирует только compose + 50x.html)
→ править на хосте, не забывать при пересоздании.

### 4. Альтернатива login-flow: не доводить до checkpoint

Снизить вероятность checkpoint в принципе:
- ✅ `playwright-stealth` подключён (browser_session.py: `_STEALTH.apply_stealth_async(ctx)`)
  — `navigator.webdriver=false`, поддельные plugins/webgl, platform=Win32.
  Проверено: headless без stealth даёт `navigator.webdriver=true` (палево), с ним — false.
- ⏳ residential-прокси со стабильным IP на аккаунт (см. блокер proxy_url —
  текущий прод-socks5+auth не годится, нужен HTTP).
- ⏳ прогрев аккаунта вручную перед первым автозапуском; первичный логин один
  раз через VNC, дальше демон на сохранённых cookies.

## Acceptance

На dogfood: запустить кампанию на свежем аккаунте → дождаться `needs_captcha`
→ открыть `https://polza-portal.ru/openoutreach-vnc/` → решить капчу руками →
дёрнуть resume → демон продолжает БЕЗ повторного checkpoint, инвайты уходят.
