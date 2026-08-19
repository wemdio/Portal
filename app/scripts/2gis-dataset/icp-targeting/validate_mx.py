"""Проверка MX у доменов почты — отсев гарантированных bounce'ов.

Домен без MX-записи почту не принимает: письмо на него отскочит и испортит
репутацию отправляющего домена. Для холодной рассылки это обязательный шаг,
а не опция.

Результат кэшируется в mx.json, поэтому повторный прогон почти бесплатный.
Читает companies.jsonl + crawl.jsonl, пишет mx.json: {домен: {...}}.
"""
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import dns.exception
import dns.resolver

import lib_norm as L

HERE = L.WORK
OUT = os.path.join(HERE, 'mx.json')
WORKERS = int(os.environ.get('MX_WORKERS', '32'))

_tl = threading.local()


def resolver():
    if not hasattr(_tl, 'r'):
        r = dns.resolver.Resolver()
        r.timeout = 4
        r.lifetime = 8
        _tl.r = r
    return _tl.r


def check(domain):
    """-> (домен, {'mx': bool, 'host': str, 'note': str})."""
    try:
        ans = resolver().resolve(domain, 'MX')
        hosts = sorted((r.preference, str(r.exchange).rstrip('.')) for r in ans)
        if hosts:
            return domain, {'mx': True, 'host': hosts[0][1], 'note': ''}
        return domain, {'mx': False, 'host': '', 'note': 'empty-mx'}
    except dns.resolver.NoAnswer:
        # нет MX — по RFC 5321 почта может идти на A-запись; помечаем отдельно
        try:
            resolver().resolve(domain, 'A')
            return domain, {'mx': False, 'host': '', 'note': 'a-record-only'}
        except dns.exception.DNSException:
            return domain, {'mx': False, 'host': '', 'note': 'no-a'}
    except dns.resolver.NXDOMAIN:
        return domain, {'mx': False, 'host': '', 'note': 'nxdomain'}
    except dns.resolver.NoNameservers:
        return domain, {'mx': False, 'host': '', 'note': 'no-ns'}
    except dns.exception.Timeout:
        return domain, {'mx': False, 'host': '', 'note': 'timeout'}
    except dns.exception.DNSException as e:
        return domain, {'mx': False, 'host': '', 'note': type(e).__name__}


def main():
    domains = set()
    for line in open(os.path.join(HERE, 'companies.jsonl'), encoding='utf-8'):
        for e in json.loads(line)['emails']:
            domains.add(e.rsplit('@', 1)[-1])
    p = os.path.join(HERE, 'crawl.jsonl')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            for e in r.get('emails') or []:
                domains.add(e.rsplit('@', 1)[-1])

    cache = {}
    if os.path.exists(OUT):
        cache = json.load(open(OUT, encoding='utf-8'))
    # таймаут — это «не дозвонились до DNS», а не вердикт о домене:
    # такие перепроверяем на следующем прогоне
    RETRY = {'timeout', 'no-ns'}
    todo = sorted(d for d in domains if d and (
        d not in cache or cache[d].get('note') in RETRY))
    print(f'доменов почты: {len(domains)}, в кэше {len(cache)}, проверить {len(todo)}',
          flush=True)

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for dom, res in ex.map(check, todo):
            cache[dom] = res
            done += 1
            if done % 500 == 0:
                print(f'  {done}/{len(todo)}', flush=True)
                json.dump(cache, open(OUT, 'w', encoding='utf-8'),
                          ensure_ascii=False, indent=0)

    json.dump(cache, open(OUT, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=0)
    ok = sum(1 for v in cache.values() if v['mx'])
    print(f'\nс MX: {ok} из {len(cache)}')
    notes = {}
    for v in cache.values():
        if not v['mx']:
            notes[v['note']] = notes.get(v['note'], 0) + 1
    for k, n in sorted(notes.items(), key=lambda x: -x[1]):
        print(f'  без MX / {k}: {n}')


if __name__ == '__main__':
    main()
