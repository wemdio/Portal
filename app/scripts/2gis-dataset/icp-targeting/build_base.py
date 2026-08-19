"""Стадия A: 28 416 карточек 2GIS -> схлопнутая база компаний с ICP-скором.

Выход: companies.jsonl (полное состояние для стадии B) + диагностика в stdout.
"""
import json
import os
import re
from collections import Counter, defaultdict

import lib_norm as L
import lib_icp as I

OUT = os.path.join(L.WORK, 'companies.jsonl')

# Маркеры того, что название карточки — это ЖК/объект, а не компания.
PROJECT_MARKERS = re.compile(
    r'жилой комплекс|жилой район|жилой квартал|микрорайон|клубный дом|'
    r'строящийся|строящиеся|апартаменты|офис продаж|отдел продаж|'
    r'коттеджный посёлок|коттеджный поселок|квартал|таунхаус|'
    r'жк\b|филиал|представительство|стройплощадка|шоурум|'
    r'демонстрационн|выставочн', re.I)
COMPANY_MARKERS = re.compile(
    r'строительная компания|группа компаний|ооо|оао|зао|пао|'
    r'\bгк\b|\bск\b|холдинг|корпорация|застройщик|девелопер|'
    r'проектная компания|инжиниринговая|трест|комбинат|завод|'
    r'институт|объединение|управление|бюро', re.I)


RU2LAT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
}


def translit(s):
    return ''.join(RU2LAT.get(ch, ch) for ch in (s or '').lower())


def slug(s):
    return re.sub(r'[^a-z0-9]', '', translit(s))


# «Мусорные» префиксы, которые не могут быть именем компании.
GENERIC_PREFIX = re.compile(
    r'^(жк|ж/к|дом|дома|квартал|микрорайон|комплекс|新)$', re.I)


def pick_name(names_counter, domain):
    """Имя компании из названий карточек 2GIS.

    Карточки застройщика — это, как правило, названия ЖК («Саларьево парк,
    жилой комплекс»), а не имя компании. Три стратегии по убыванию надёжности:
      1) общий префикс до запятой у заметной доли карточек («DOGMA, ЖК ...»);
      2) название карточки, совпадающее с меткой домена (translit);
      3) производное от домена — помечаем derived, настоящее имя добираем
         из <title> сайта на стадии B.
    """
    total = sum(names_counter.values())
    dom_label = domain.split('.')[0] if domain else ''

    # (1) общий бренд-префикс до первой запятой. Требуем, чтобы префикс
    # встречался у РАЗНЫХ названий карточек: иначе побеждает просто самый
    # растиражированный ЖК («Скандинавия» у a101.ru — 47 карточек одного ЖК).
    prefixes = Counter()
    prefix_names = defaultdict(set)
    for nm, cnt in names_counter.items():
        p = nm.split(',')[0].strip()
        if p and len(p) >= 2 and not GENERIC_PREFIX.match(p):
            prefixes[p] += cnt
            prefix_names[p].add(nm)
    if prefixes:
        p, cnt = prefixes.most_common(1)[0]
        share = cnt / total if total else 0
        if (len(prefix_names[p]) >= 2 and share >= 0.25
                and not PROJECT_MARKERS.search(p)):
            return p, 'prefix'

    # (2) карточка, чьё название совпадает с доменом
    if dom_label and len(dom_label) >= 3:
        for nm, _ in names_counter.most_common():
            head = nm.split(',')[0].strip()
            s = slug(head)
            if s and (s == dom_label or (len(s) >= 4 and s in slug(dom_label))
                      or (len(dom_label) >= 4 and dom_label in s)):
                return head, 'domain-match'

    # (3) явно не-проектное название карточки. У компании с россыпью объектов
    # любое отдельное название — это, скорее всего, ЖК, поэтому доверяем
    # карточке только когда объектов мало.
    cands = [(nm, cnt) for nm, cnt in names_counter.items()
             if not PROJECT_MARKERS.search(nm)]
    if cands and (total < 5 or not dom_label):
        cands.sort(key=lambda x: (bool(COMPANY_MARKERS.search(x[0])), x[1],
                                  -len(x[0])), reverse=True)
        return cands[0][0].split(',')[0].strip(), 'card'

    # (4) от домена — плейсхолдер до обогащения из <title> на стадии B
    if dom_label:
        return domain_to_name(dom_label), 'derived-from-domain'
    if cands:
        return cands[0][0].split(',')[0].strip(), 'card'
    return (names_counter.most_common(1)[0][0] if names_counter else ''), 'card'


VOWELS = set('aeiouy')


def domain_to_name(label):
    """'lsr' -> 'LSR', 'group-akvilon' -> 'Group Akvilon'."""
    parts = [p for p in re.split(r'[-_]', label) if p]
    out = []
    for p in parts:
        # короткая метка почти без гласных — это аббревиатура (lsr, cds, dsk)
        if len(p) <= 4 and sum(1 for ch in p if ch in VOWELS) <= 1:
            out.append(p.upper())
        else:
            out.append(p.capitalize())
    return ' '.join(out)


def size_band(n_objects):
    """Число объектов в 2GIS -> (полоса размера, вклад в скор).

    Пик — региональный застройщик/подрядчик на 5-29 объектов: как раз масштаб
    под 25-200 пользователей СЭД. Крайности штрафуем: одна карточка почти
    всегда микробизнес, сотня карточек — enterprise не нашего чека.
    """
    if n_objects >= 100:
        return 'enterprise (100+)', 10
    if n_objects >= 30:
        return 'крупный (30-99)', 22
    if n_objects >= 10:
        return 'целевой (10-29)', 30
    if n_objects >= 5:
        return 'целевой (5-9)', 26
    if n_objects >= 2:
        return 'малый (2-4)', 16
    return 'один объект', 0


def main():
    rows = L.load_rows()
    print(f'загружено карточек: {len(rows)}')

    # ---------------------------------------------------------- группировка
    groups = defaultdict(list)
    stat = Counter()
    for r in rows:
        host = L.host_of(r['website'])
        dom = ''
        if host and host not in L.NON_CORPORATE:
            dom = L.registrable(host, L.EXTRA_SUFFIXES)
            if dom in L.NON_CORPORATE:
                dom = ''
        if dom:
            key = ('d', dom)
            stat['по домену'] += 1
        else:
            key = ('n', L.norm_name(r['name']), r['city_name'])
            stat['по названию+городу'] += 1
        groups[key].append(r)

    print(f'ключей группировки: {len(groups)}  ({dict(stat)})')

    companies = []
    for key, cards in groups.items():
        domain = key[1] if key[0] == 'd' else ''
        names = Counter(c['name'].strip() for c in cards if c['name'].strip())
        name, name_src = pick_name(names, domain)
        cities = {c['city_name'].strip() for c in cards if c['city_name'].strip()}
        subcats = set()
        for c in cards:
            for t in c['subcategory'].split(','):
                t = t.strip()
                if t:
                    subcats.add(t)

        emails = sorted({e for c in cards for e in L.norm_emails(c['email'])})
        emails = [e for e in emails
                  if e.split('@')[0] not in L.ROLE_JUNK_LOCAL]
        phones = sorted({p for c in cards for p in L.norm_phones(c['phone'])})
        sites = Counter(c['website'].strip() for c in cards if c['website'].strip())

        corp_emails = [e for e in emails
                       if domain and e.split('@')[1].endswith(domain)]
        free_emails = [e for e in emails if e.split('@')[1] in L.FREE_MAIL]

        tier, t1, t2, b2c = I.classify_rubrics(subcats)

        companies.append({
            'key': '|'.join(key),
            'name': name,
            'name_src': name_src,
            'domain': domain,
            'website': sites.most_common(1)[0][0] if sites else '',
            'cities': sorted(cities),
            'primary_city': Counter(
                c['city_name'].strip() for c in cards
                if c['city_name'].strip()).most_common(1)[0][0] if cities else '',
            'cards': len(cards),
            'subcats': sorted(subcats),
            'tier': tier,
            't1': sorted(t1), 't2': sorted(t2), 'b2c': sorted(b2c),
            'emails': emails,
            'corp_emails': corp_emails,
            'free_emails': free_emails,
            'phones': phones,
            'card_ids': [c['id'] for c in cards],
        })

    print(f'компаний после схлопывания: {len(companies)}')
    print()

    # ---------------------------------------------------------------- скор
    for c in companies:
        s, why = 0, []
        if c['tier'] == 1:
            s += 40; why.append('рубрика T1')
        elif c['tier'] == 2:
            s += 20; why.append('рубрика T2')

        if c['b2c']:
            pen = 8 if c['tier'] == 1 else 15
            s -= pen; why.append(f'B2C-рубрика -{pen}')

        # Масштаб — это кривая попадания, а не «чем больше, тем лучше».
        # По брифу ICP = 25-200 пользователей и чек 3-5 млн ₽. Застройщик с
        # сотней объектов — это enterprise: у него почти наверняка уже стоит
        # ECM, а закупка идёт другим тиром и другими деньгами. Плюс наш же
        # опыт: «девелоперы 1млрд+» дали 0% reply против 7.45% на СМБ
        # (wiki/subjects/winning-patterns.md).
        n = c['cards']
        band, pts = size_band(n)
        c['size_band'] = band
        if pts:
            s += pts; why.append(f'{n} объектов ({band}) +{pts}')

        ncity = len(c['cities'])
        for lim, pts in ((4, 12), (2, 6)):
            if ncity >= lim:
                s += pts; why.append(f'{ncity} городов +{pts}')
                break

        if c['domain']:
            s += 10; why.append('свой домен')
        if c['corp_emails']:
            s += 10; why.append('почта на своём домене')
        elif c['free_emails']:
            s += 3; why.append('только free-mail')

        cs = I.city_score(set(c['cities']))
        if cs:
            s += cs; why.append(f'город +{cs}')

        c['score'] = s
        c['why'] = why

    companies.sort(key=lambda x: -x['score'])

    with open(OUT, 'w', encoding='utf-8') as f:
        for c in companies:
            f.write(json.dumps(c, ensure_ascii=False) + '\n')

    # --------------------------------------------------------- диагностика
    print('--- распределение по tier ---')
    for t, n in sorted(Counter(c['tier'] for c in companies).items()):
        print(f'  T{t}: {n}')
    print()
    print('--- воронка ---')
    icp = [c for c in companies if c['tier'] in (1, 2)]
    print(f'  всего компаний            {len(companies)}')
    print(f'  ICP-рубрики (T1+T2)       {len(icp)}')
    print(f'  из них со своим доменом   {sum(1 for c in icp if c["domain"])}')
    print(f'  из них с email уже сейчас {sum(1 for c in icp if c["emails"])}')
    print(f'  T1 со своим доменом       {sum(1 for c in icp if c["tier"]==1 and c["domain"])}')
    print()
    print('--- топ-25 по скору ---')
    for c in companies[:25]:
        em = c['emails'][0] if c['emails'] else '—'
        print(f'  {c["score"]:4d} {c["name"][:44]:44s} {c["domain"][:24]:24s} '
              f'карт={c["cards"]:4d} T{c["tier"]} {em}')
    print()
    print('--- гистограмма скора ---')
    h = Counter(min(c['score'] // 10 * 10, 100) for c in companies)
    for b in sorted(h, reverse=True):
        print(f'  {b:4d}+ : {h[b]:6d}  {"#" * min(60, h[b] // 40)}')


if __name__ == '__main__':
    main()
