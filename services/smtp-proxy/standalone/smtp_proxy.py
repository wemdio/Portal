#!/usr/bin/env python3
"""Standalone SMTP-probe proxy — a faithful Python port of services/smtp-proxy
(smtp.ts + server.ts). Runs on the Timeweb VPS (no Node/Docker there).

Contract MUST match the Node proxy exactly, because the worker's failover
(isInconclusiveTransport in validator.ts) keys on the error strings, and the
verdict logic keys on {code, exists, isCatchAll, greylist, smtpText}.

  POST /smtp-check  Bearer <SMTP_PROXY_API_KEY>
    body: {email, mxHost, heloDomain?, heloFrom?, checkCatchAll?, timeout?}
    -> {code, exists, isCatchAll, greylist, smtpText?, error?}
  GET /health -> {"status":"ok"}

Env: SMTP_PROXY_API_KEY (required), PORT (default 3100),
     EMAIL_VALIDATION_HELO_DOMAIN (HELO name), EMAIL_VALIDATION_MAIL_FROM (default ''),
     SMTP_PROBE_LOCAL_ADDRESS (optional egress bind),
     SMTP_CHECK_DEADLINE_MS (overall per-check deadline, default 21000).
"""
import os, sys, json, socket, time, hmac, re, errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = os.environ.get("SMTP_PROXY_API_KEY", "")
PORT = int(os.environ.get("PORT", "3100"))
HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_HELO = os.environ.get("EMAIL_VALIDATION_HELO_DOMAIN") or socket.gethostname()
DEFAULT_MAIL_FROM = os.environ.get("EMAIL_VALIDATION_MAIL_FROM", "")
LOCAL_ADDR = (os.environ.get("SMTP_PROBE_LOCAL_ADDRESS") or "").strip() or None
PROBE_PORT = int(os.environ.get("SMTP_PROBE_PORT", "25"))

CONNECT_TIMEOUT = 8.0
COMMAND_TIMEOUT = 8.0
# Общий дедлайн всей проверки (сек): воркер обрывает HTTP-вызов к прокси на 25s,
# ответ позже дедлайна никто не получит — опциональные фазы (in-session catch-all
# и retry на свежем коннекте) после него не стартуют.
CHECK_DEADLINE = float(os.environ.get("SMTP_CHECK_DEADLINE_MS", "21000")) / 1000.0
# Per-stage таймаут retry-пробы на свежем коннекте (минимум с остатком бюджета).
CATCHALL_RETRY_TIMEOUT = 5.0

if not API_KEY:
    print("SMTP_PROXY_API_KEY env variable is required", file=sys.stderr)
    sys.exit(1)

_FINAL_LINE = re.compile(rb"^\d{3} ", re.M)
_CTRL = re.compile(r"[\r\n\0]")


def _read_reply(sock, timeout):
    """Accumulate one SMTP reply until the final line '<code><space>'."""
    sock.settimeout(timeout)
    buf = b""
    while True:
        chunk = sock.recv(512)
        if not chunk:
            raise ConnectionError("SMTP connection closed before reply")
        buf += chunk
        if _FINAL_LINE.search(buf):
            break
        if len(buf) > 8192:
            break
    text = buf.decode("utf-8", "replace").strip()
    m = re.match(r"^(\d{3})[\s-]", text)
    code = int(m.group(1)) if m else 0
    return code, text


def _cmd(sock, line, timeout):
    sock.sendall((line + "\r\n").encode())
    return _read_reply(sock, timeout)


def _connect(mx, timeout):
    src = (LOCAL_ADDR, 0) if LOCAL_ADDR else None
    # Только IPv4 (parity с family:4 в smtp.ts): PTR/HELO настроены под IPv4
    # egress'а, а AAAA-выбор на VPS без IPv6 убивал пробу с ENETUNREACH.
    last_err = None
    for family, socktype, proto, _, sa in socket.getaddrinfo(
            mx, PROBE_PORT, socket.AF_INET, socket.SOCK_STREAM):
        s = socket.socket(family, socktype, proto)
        s.settimeout(timeout)
        try:
            if src:
                s.bind(src)
            s.connect(sa)
            return s
        except OSError as e:
            last_err = e
            s.close()
    if last_err is not None:
        raise last_err
    raise OSError("no IPv4 address for %s" % mx)


def _random_local(domain):
    return "verify-check-%d-%s@%s" % (int(time.time() * 1000), os.urandom(4).hex(), domain)


def _quit_and_close(s):
    """QUIT — fire-and-forget (parity с quitAndDestroy в smtp.ts): ответ не ждём
    (это до 3s чистой задержки на пробу), пишем QUIT и сразу закрываем сокет."""
    try:
        s.sendall(b"QUIT\r\n")
    except Exception:
        pass
    try:
        s.close()
    except Exception:
        pass


def _fresh_probe(mx, helo, mail_from, recipient, timeout):
    """One-shot RCPT probe on a FRESH connection (catch-all fallback)."""
    s = None
    try:
        s = _connect(mx, timeout)
        code, _ = _read_reply(s, timeout)
        if code != 220:
            return None
        code, _ = _cmd(s, "EHLO " + helo, timeout)
        if code != 250:
            code, _ = _cmd(s, "HELO " + helo, timeout)
            if code != 250:
                return None
        code, _ = _cmd(s, "MAIL FROM:<%s>" % mail_from, timeout)
        if code != 250:
            return None
        code, text = _cmd(s, "RCPT TO:<%s>" % recipient, timeout)
        _quit_and_close(s)
        return code
    except Exception:
        return None
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass


def smtp_check(req):
    started = time.time()
    timeout = float(req.get("timeout") or CONNECT_TIMEOUT * 1000) / 1000.0
    result = {"code": 0, "exists": None, "isCatchAll": None, "greylist": False}
    helo = req.get("heloDomain") or DEFAULT_HELO
    mail_from = req.get("heloFrom")
    if mail_from is None:
        mail_from = DEFAULT_MAIL_FROM
    email = req.get("email", "")
    mx = req.get("mxHost", "")

    for v in (email, mx, helo, mail_from):
        if isinstance(v, str) and _CTRL.search(v):
            result["error"] = "Invalid characters in request"
            return result

    s = None
    try:
        try:
            s = _connect(mx, timeout)
        except socket.timeout:
            result["error"] = "SMTP connect timeout"
            return result
        code, text = _read_reply(s, COMMAND_TIMEOUT)
        if code != 220:
            # 4xx на баннере — greylisting (MX временно отклоняет новый egress-IP):
            # сигнал greylist, а не transport-ошибка — воркер не устраивает
            # failover-шторм, а делает отложенный retry с того же IP (affinity).
            # 5xx на этих стадиях — блок egress/anti-probe, остаётся ошибкой.
            if 400 <= code < 500:
                result["code"] = code
                result["greylist"] = True
                result["smtpText"] = text
                return result
            result["error"] = "Unexpected greeting: %d" % code
            return result
        code, text = _cmd(s, "EHLO " + helo, COMMAND_TIMEOUT)
        if code != 250:
            code, text = _cmd(s, "HELO " + helo, COMMAND_TIMEOUT)
            if code != 250:
                # 4xx на EHLO/HELO — greylist (см. выше); 5xx — блок egress, ошибка.
                if 400 <= code < 500:
                    result["code"] = code
                    result["greylist"] = True
                    result["smtpText"] = text
                    return result
                result["error"] = "EHLO/HELO rejected: %d" % code
                return result
        code, text = _cmd(s, "MAIL FROM:<%s>" % mail_from, COMMAND_TIMEOUT)
        if code != 250:
            # 4xx на MAIL FROM — greylist (см. выше); 5xx — блок egress, ошибка.
            if 400 <= code < 500:
                result["code"] = code
                result["greylist"] = True
                result["smtpText"] = text
                return result
            result["error"] = "MAIL FROM rejected: %d" % code
            return result
        code, text = _cmd(s, "RCPT TO:<%s>" % email, COMMAND_TIMEOUT)
        result["code"] = code
        result["smtpText"] = text
        if code in (250, 251):
            result["exists"] = True
        elif code == 252:
            # 252 — сервер принимает получателя, но не подтверждает его
            # существование (Cannot VRFY): честный catch_all, а не 'ok'.
            result["exists"] = True
            result["isCatchAll"] = True
        elif 550 <= code <= 559:
            result["exists"] = False
        elif code == 452:
            # 452 (over quota / insufficient storage) — НЕ greylist: временный
            # отказ по квоте самого ящика, а не по IP. Классификацию квоты
            # по smtpText делает валидатор.
            result["exists"] = None
        elif 450 <= code <= 459:
            result["greylist"] = True
            result["exists"] = None
        elif 400 <= code < 500:
            result["greylist"] = True
            result["exists"] = None

        # Вторая транзакция (catch-all) стартует, только если до общего дедлайна
        # есть бюджет: после него воркер ответ уже не ждёт, а exists важнее
        # уточнения isCatchAll. При 252 isCatchAll уже известен — не пробуем снова.
        if (req.get("checkCatchAll") and result["exists"] is True
                and result["isCatchAll"] is None
                and time.time() - started < CHECK_DEADLINE):
            # Отдельный try/except: сбой RSET/второй транзакции НЕ должен ставить
            # result["error"] — exists уже известен, и stale error протекал бы в
            # details валидатора. Остаётся isCatchAll=None, ниже — retry на
            # свежем коннекте.
            try:
                domain = email.split("@")[1] if "@" in email else ""
                rnd = _random_local(domain)
                _cmd(s, "RSET", COMMAND_TIMEOUT)
                _cmd(s, "MAIL FROM:<%s>" % mail_from, COMMAND_TIMEOUT)
                ccode, _ = _cmd(s, "RCPT TO:<%s>" % rnd, COMMAND_TIMEOUT)
                if ccode == 250:
                    result["isCatchAll"] = True
                elif 550 <= ccode <= 559:
                    result["isCatchAll"] = False
            except Exception:
                pass

        _quit_and_close(s)
    except socket.timeout:
        result["error"] = "SMTP timeout waiting for reply"
    except ConnectionRefusedError:
        result["error"] = "connect ECONNREFUSED %s:%d" % (mx, PROBE_PORT)
        result["exists"] = None
    except (ConnectionResetError, ConnectionError) as e:
        result["error"] = "connection closed: %s" % (str(e) or "ECONNRESET")
    except OSError as e:
        # Host/network unreachable etc. (EHOSTUNREACH, ENETUNREACH, EADDRNOTAVAIL,
        # EACCES). Emit "connect <ERRNAME> ..." like Node's net error message so the
        # worker's isInconclusiveTransport regex (matches "connect"/"ehostunreach"/
        # "enetunreach") triggers FAILOVER to another egress IP instead of treating
        # this as a definitive non-answer.
        name = errno.errorcode.get(e.errno or 0, "")
        result["error"] = ("connect %s %s" % (name, e.strerror or "")).strip()
        result["exists"] = None
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass

    # Fresh-connection catch-all retry (parity with smtp.ts): ограничен общим
    # дедлайном, per-stage таймаут — min(CATCHALL_RETRY_TIMEOUT, остаток бюджета).
    remaining = CHECK_DEADLINE - (time.time() - started)
    if (req.get("checkCatchAll") and result["exists"] is True
            and result["isCatchAll"] is None and remaining > 0):
        domain = email.split("@")[1] if "@" in email else ""
        if domain:
            ccode = _fresh_probe(mx, helo, mail_from, _random_local(domain),
                                 min(CATCHALL_RETRY_TIMEOUT, remaining))
            if ccode == 250:
                result["isCatchAll"] = True
            elif ccode is not None and 550 <= ccode <= 559:
                result["isCatchAll"] = False

    return result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # quiet

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        h = self.headers.get("Authorization", "")
        return hmac.compare_digest(h.encode(), ("Bearer " + API_KEY).encode())

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "ok"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/smtp-check":
            return self._json(404, {"error": "not found"})
        if not self._auth_ok():
            return self._json(401, {"error": "Unauthorized"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return self._json(400, {"code": 0, "exists": None, "isCatchAll": None,
                                    "greylist": False, "error": "bad json"})
        if not req.get("email") or not req.get("mxHost"):
            return self._json(200, {"code": 0, "exists": None, "isCatchAll": None,
                                    "greylist": False, "error": "Missing required fields"})
        try:
            self._json(200, smtp_check(req))
        except Exception as e:
            self._json(200, {"code": 0, "exists": None, "isCatchAll": None,
                             "greylist": False, "error": "proxy error: %s" % e})


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("smtp-proxy(py) listening on %s:%d helo=%s" % (HOST, PORT, DEFAULT_HELO))
    srv.serve_forever()
