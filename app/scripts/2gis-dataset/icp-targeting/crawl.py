"""Стадия B: добор контактов с сайтов компаний.

С каждого домена берём главную + наиболее вероятную страницу контактов и
вытаскиваем: email, ИНН/ОГРН (пригодится для последующего фильтра по размеру
через ФНС), настоящее название из <title>/og:site_name, телефоны.

Пишет результат построчно в crawl.jsonl — прогон возобновляем, уже обойдённые
домены пропускаются.
"""
import html
import json
import os
import random
import re
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlparse

import requests
from requests.adapters import HTTPAdapter

import lib_norm as L

HERE = L.WORK
IN = os.path.join(HERE, 'companies.jsonl')
OUT = os.path.join(HERE, 'crawl.jsonl')

WORKERS = int(os.environ.get('WORKERS', '96'))
TIMEOUT = (5, 12)          # (connect, read)
MAX_BYTES = 300_000        # хватает на шапку+подвал; тяжёлые SPA всё равно
                           # не отдают контакты в HTML
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/125.0 Safari/537.36')

# Ссылки, ведущие на страницу контактов
CONTACT_HREF = re.compile(
    r'contact|kontakt|контакт|about|o-kompanii|o-nas|about-us|company|'
    r'о-компании|реквизит|requisit', re.I)
CONTACT_TEXT = re.compile(
    r'контакт|о\s*компании|о\s*нас|реквизит|связаться|обратная\s*связь', re.I)

HREF_RE = re.compile(r'<a\b[^>]*?href\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                     re.I | re.S)
TITLE_RE = re.compile(r'<title[^>]*>(.*?)</title>', re.I | re.S)
OG_SITE_RE = re.compile(
    r'<meta[^>]+property\s*=\s*["\']og:site_name["\'][^>]+content\s*=\s*["\']([^"\']+)',
    re.I)
OG_SITE_RE2 = re.compile(
    r'<meta[^>]+content\s*=\s*["\']([^"\']+)["\'][^>]*property\s*=\s*["\']og:site_name["\']',
    re.I)
MAILTO_RE = re.compile(r'mailto:([^"\'>?\s]+)', re.I)
INN_RE = re.compile(r'ИНН\D{0,12}?(\d{10}|\d{12})', re.I)
OGRN_RE = re.compile(r'ОГРН\D{0,12}?(\d{13}|\d{15})', re.I)
TAG_RE = re.compile(r'<(script|style|noscript)\b.*?</\1>', re.I | re.S)

# «Почта», которая на самом деле имя файла/чужой сервис
BAD_EMAIL_DOMAIN = re.compile(
    r'\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?|ttf|pdf|mp4)$', re.I)
BAD_EMAIL_HOST = {
    'example.com', 'example.org', 'domain.com', 'mail.com', 'email.com',
    'sentry.io', 'wixpress.com', 'sentry.wixpress.com', 'company.com',
    'site.ru', 'mysite.ru', 'test.ru', 'your-domain.com', 'yourdomain.com',
    '2x.png', 'localhost', 'yandex.net', 'googlemail.com',
}
BAD_LOCAL = re.compile(r'^(u00|x[0-9a-f]{2}|[0-9a-f]{16,})', re.I)
# Заглушки из плейсхолдеров форм и служебные ящики виджетов/счётчиков.
PLACEHOLDER_LOCAL = {
    'ivanov', 'ivanova', 'petrov', 'sidorov', 'ivan', 'example', 'primer',
    'name', 'yourname', 'your', 'youremail', 'email', 'e-mail', 'mail',
    'pochta', 'test', 'user', 'username', 'login', 'somebody', 'someone',
    'rating', 'counter', 'metrika', 'analytics', 'support-widget',
}

_lock = threading.Lock()
_stop = threading.Event()


def make_session():
    s = requests.Session()
    ad = HTTPAdapter(pool_connections=WORKERS, pool_maxsize=WORKERS, max_retries=0)
    s.mount('http://', ad)
    s.mount('https://', ad)
    s.headers.update({
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
    })
    return s


_tl = threading.local()


def session():
    if not hasattr(_tl, 's'):
        _tl.s = make_session()
    return _tl.s


def fetch(url):
    """-> (final_url, text, status, err). Кодировку чиним через charset_normalizer."""
    try:
        r = session().get(url, timeout=TIMEOUT, allow_redirects=True, stream=True)
        status = r.status_code
        ctype = r.headers.get('Content-Type', '')
        if 'html' not in ctype and 'xml' not in ctype and ctype:
            r.close()
            return r.url, '', status, 'not-html'
        raw = b''
        for chunk in r.iter_content(65536):
            raw += chunk
            if len(raw) > MAX_BYTES:
                break
        r.close()
        enc = None
        m = re.search(br'charset\s*=\s*["\']?\s*([\w\-]+)', raw[:4000], re.I)
        if m:
            enc = m.group(1).decode('ascii', 'ignore')
        for cand in (enc, r.encoding, 'utf-8', 'cp1251'):
            if not cand:
                continue
            try:
                return r.url, raw.decode(cand, 'strict'), status, ''
            except (UnicodeDecodeError, LookupError):
                continue
        return r.url, raw.decode('utf-8', 'ignore'), status, ''
    except requests.exceptions.SSLError as e:
        return url, '', 0, 'ssl'
    except requests.exceptions.ConnectTimeout:
        return url, '', 0, 'connect-timeout'
    except requests.exceptions.ReadTimeout:
        return url, '', 0, 'read-timeout'
    except requests.exceptions.TooManyRedirects:
        return url, '', 0, 'redirects'
    except requests.exceptions.ConnectionError as e:
        return url, '', 0, 'conn'
    except Exception as e:
        return url, '', 0, type(e).__name__


def clean_text(doc):
    return TAG_RE.sub(' ', doc)


def extract_emails(doc, base_host):
    found = set()
    for m in MAILTO_RE.finditer(doc):
        found.add(html.unescape(m.group(1)).strip().lower())
    txt = html.unescape(clean_text(doc))
    # частая обфускация: "info (собака) domain.ru"
    txt = re.sub(r'\s*[\(\[]\s*(?:собака|at|dog)\s*[\)\]]\s*', '@', txt, flags=re.I)
    for m in L.EMAIL_RE.finditer(txt):
        found.add(m.group(0).lower())
    out = set()
    for e in found:
        e = e.strip(" .,;:'\"<>()[]")
        if e.count('@') != 1:
            continue
        local, dom = e.split('@')
        if not local or not dom or len(e) > 90:
            continue
        if BAD_EMAIL_DOMAIN.search(dom) or dom in BAD_EMAIL_HOST:
            continue
        if BAD_LOCAL.match(local) or local in L.ROLE_JUNK_LOCAL:
            continue
        # заглушка на бесплатной почте = пример из формы, а не контакт компании
        if local in PLACEHOLDER_LOCAL and dom in L.FREE_MAIL:
            continue
        if not re.match(r'^[a-z0-9][a-z0-9._%+\-]*$', local):
            continue
        if not re.match(r'^[a-z0-9.\-]+\.[a-z]{2,}$', dom):
            continue
        if dom.split('.')[-1].isdigit():
            continue
        out.add(e)
    return out


def extract_title(doc):
    for rx in (OG_SITE_RE, OG_SITE_RE2):
        m = rx.search(doc)
        if m:
            t = html.unescape(m.group(1)).strip()
            if t:
                return t[:160]
    m = TITLE_RE.search(doc)
    if m:
        return re.sub(r'\s+', ' ', html.unescape(m.group(1))).strip()[:160]
    return ''


def contact_links(doc, base_url):
    """Кандидаты на страницу контактов, лучшие первыми."""
    cands = []
    for m in HREF_RE.finditer(doc):
        href, text = m.group(1), re.sub(r'<[^>]+>', '', m.group(2))
        if href.startswith(('mailto:', 'tel:', 'javascript:', '#')):
            continue
        score = 0
        if CONTACT_HREF.search(href):
            score += 2
        if CONTACT_TEXT.search(html.unescape(text)):
            score += 3
        if score:
            try:
                u = urljoin(base_url, html.unescape(href))
            except ValueError:
                continue
            if urlparse(u).netloc and u.startswith(('http://', 'https://')):
                cands.append((score, u))
    seen, out = set(), []
    for score, u in sorted(cands, key=lambda x: -x[0]):
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out[:1]


def work(rec):
    dom = rec['domain']
    res = {'key': rec['key'], 'domain': dom, 'ok': False, 'err': '',
           'emails': [], 'inn': [], 'ogrn': [], 'title': '', 'final_url': '',
           'pages': 0, 'status': 0}
    if _stop.is_set():
        res['err'] = 'aborted'
        return res

    doc = ''
    for scheme in ('https://', 'http://'):
        final, body, status, err = fetch(scheme + dom)
        res['status'], res['err'], res['final_url'] = status, err, final
        # 401/403 от антибота тоже отдают тело — успехом это не считаем
        if body and 200 <= status < 300:
            doc = body
            break
        if body:
            res['err'] = res['err'] or f'http-{status}'
        # http:// пробуем только если https не дожил до ответа; на реальный
        # HTTP-статус повтор по другой схеме ничего не изменит, только время
        if status:
            break
    if not doc:
        return res

    res['ok'] = True
    res['pages'] = 1
    res['title'] = extract_title(doc)
    emails = extract_emails(doc, dom)
    blob = clean_text(doc)
    inn = set(INN_RE.findall(blob))
    ogrn = set(OGRN_RE.findall(blob))

    # страница контактов — там обычно и почта, и реквизиты
    for url in contact_links(doc, res['final_url'] or ('https://' + dom)):
        if _stop.is_set():
            break
        _, d2, _, _ = fetch(url)
        if not d2:
            continue
        res['pages'] += 1
        emails |= extract_emails(d2, dom)
        b2 = clean_text(d2)
        inn |= set(INN_RE.findall(b2))
        ogrn |= set(OGRN_RE.findall(b2))
        if emails and inn:
            break

    res['emails'] = sorted(emails)
    res['inn'] = sorted(inn)
    res['ogrn'] = sorted(ogrn)
    return res


def main():
    companies = [json.loads(l) for l in open(IN, encoding='utf-8')]
    # обходим только ICP-рубрики со своим доменом
    targets = [c for c in companies if c['tier'] in (1, 2) and c['domain']]
    # порядок по скору: если прогон прервут, успеет обойти самых ценных
    targets.sort(key=lambda c: -c['score'])

    done = set()
    if os.path.exists(OUT):
        for line in open(OUT, encoding='utf-8'):
            try:
                done.add(json.loads(line)['key'])
            except Exception:
                pass
    todo = [c for c in targets if c['key'] not in done]
    print(f'цель: {len(targets)} доменов, уже обойдено {len(done)}, '
          f'осталось {len(todo)}, потоков {WORKERS}', flush=True)

    def on_sig(*a):
        print('\n! получен сигнал, останавливаюсь мягко', flush=True)
        _stop.set()
    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)

    t0 = time.time()
    n = ok = with_mail = with_inn = 0
    out = open(OUT, 'a', encoding='utf-8')
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(work, c): c for c in todo}
        for fut in as_completed(futs):
            try:
                r = fut.result()
            except Exception as e:
                r = {'key': futs[fut]['key'], 'domain': futs[fut]['domain'],
                     'ok': False, 'err': f'crash:{type(e).__name__}',
                     'emails': [], 'inn': [], 'ogrn': [], 'title': '',
                     'final_url': '', 'pages': 0, 'status': 0}
            n += 1
            ok += bool(r['ok'])
            with_mail += bool(r['emails'])
            with_inn += bool(r['inn'])
            with _lock:
                out.write(json.dumps(r, ensure_ascii=False) + '\n')
                if n % 200 == 0:
                    out.flush()
                    el = time.time() - t0
                    rate = n / el if el else 0
                    left = (len(todo) - n) / rate if rate else 0
                    print(f'  {n}/{len(todo)}  ok={ok} mail={with_mail} '
                          f'inn={with_inn}  {rate:.1f}/s  осталось ~{left/60:.0f} мин',
                          flush=True)
            if _stop.is_set() and n > len(todo) * 0.999:
                break
    out.close()
    el = time.time() - t0
    print(f'готово: {n} доменов за {el/60:.1f} мин; живых {ok}, '
          f'с почтой {with_mail}, с ИНН {with_inn}', flush=True)


if __name__ == '__main__':
    main()
