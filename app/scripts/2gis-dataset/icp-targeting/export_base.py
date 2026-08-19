"""Финальная сборка: companies.jsonl + crawl.jsonl -> база под outreach.

Выход:
  alial_construction_base.csv      — контакты с email, готовые к заливке
  alial_construction_no_email.csv  — ICP-компании без email (телефон/сайт есть)
  report.md                        — воронка, срезы, что осталось за бортом
"""
import csv
import json
import os
import re
from collections import Counter, defaultdict

import lib_norm as L
import lib_icp as I

HERE = L.WORK

# Приоритет ящиков под Directum RX. ЛПР по брифу — финансы, юристы,
# бухгалтерия, делопроизводство, ИТ. Общая приёмная/канцелярия для холодного
# письма про СЭД лучше отдела продаж: письмо попадает ровно в делопроизводство.
INBOX_RANK = [
    (95, 'приёмная/канцелярия', {
        'priemnaya', 'priem', 'reception', 'kanc', 'kancelyariya',
        'kancelaria', 'secretar', 'secretary', 'sekretar', 'office', 'ofis'}),
    (90, 'общая', {
        'info', 'mail', 'general', 'main', 'common', 'company', 'post',
        'contact', 'contacts', 'inbox', 'director'}),
    (85, 'руководство', {
        'dir', 'ceo', 'gd', 'genderal', 'gendir', 'boss', 'head', 'management'}),
    (80, 'финансы/бухгалтерия', {
        'buh', 'buhgalter', 'buhgalteria', 'finance', 'fin', 'finansy',
        'account', 'accounting', 'economy'}),
    (78, 'юристы', {'urist', 'jurist', 'legal', 'law', 'pravo', 'dogovor'}),
    (75, 'ИТ', {'it', 'ит', 'sysadmin', 'admin', 'itsupport', 'ito'}),
    (60, 'снабжение/тендеры', {
        'tender', 'zakupki', 'snab', 'postavka', 'procurement'}),
    (50, 'продажи', {
        'sales', 'sale', 'zakaz', 'order', 'commerce', 'kommerc',
        'client', 'clientservice', 'opt', 'manager'}),
    (20, 'HR', {
        'hr', 'job', 'jobs', 'vacancy', 'vakansii', 'rabota', 'resume',
        'personal', 'kadry', 'career'}),
    (15, 'PR/маркетинг', {
        'pr', 'press', 'smi', 'media', 'marketing', 'reklama', 'ad'}),
    (10, 'поддержка', {
        'support', 'help', 'tech', 'service', 'remont', 'garantia',
        'garantiya', 'claim', 'pretenzia'}),
]


def rank_inbox(local):
    base = re.split(r'[._\-+0-9]', local.lower())[0] or local.lower()
    for score, label, names in INBOX_RANK:
        if local.lower() in names or base in names:
            return score, label
    # похоже на имя человека (ivanov.ii@) — это персональный ящик, он ценен
    if re.match(r'^[a-z]{3,}[._][a-z]{1,}$', local.lower()):
        return 70, 'персональный'
    return 40, 'прочее'


SEGMENTS = [
    ('Застройщик / девелопер', {
        'Новостройки', 'Многоквартирное строительство', 'Девелопмент'}),
    ('Промышленное строительство', {
        'Промышленное строительство', 'Строительство и обслуживание АЭС / ГЭС / ТЭЦ',
        'Проектирование объектов добычи полезных ископаемых',
        'Строительство сельхозсооружений'}),
    ('Дорожное / инфраструктурное', {
        'Строительство / ремонт дорог', 'Проектирование дорог / мостов',
        'Строительство мостов / тоннелей', 'Строительство / ремонт железных дорог',
        'Строительство мостов / тоннелей / метрополитена',
        'Гидротехническое строительство', 'Строительство / обслуживание электросетей',
        'Строительство / обслуживание наружного газоснабжения'}),
    ('Коммерческое / административное', {
        'Строительство административных зданий', 'Строительство спортивных сооружений',
        'Строительство АЗС', 'Парковочные системы / Строительство автопаркингов'}),
    ('Инжиниринг / генподряд', {
        'Инжиниринговые услуги', 'Быстровозводимые здания'}),
    ('Проектирование / изыскания', {
        'Архитектурное проектирование', 'Проектирование инженерных систем',
        'Геологические работы', 'Геодезические работы', 'Гидрогеологические работы',
        'Геофизические работы'}),
    ('Экспертиза / контроль', {
        'Экспертиза проектной документации / инженерных изысканий',
        'Экспертиза зданий / сооружений', 'Экспертиза промышленной безопасности',
        'Энергоаудит', 'Пожарная безопасность'}),
]


def segment_of(subcats):
    s = set(subcats)
    for label, keys in SEGMENTS:
        if s & keys:
            return label
    return 'Прочее строительство'


QUOTED = re.compile(r'[«"“]([^»"”]{2,40})[»"”]')
SEP = re.compile(r'\s*[|—–\-:•]\s*')

def _slug(s):
    return re.sub(r'[^a-z0-9]', '',
                  ''.join(RU2LAT_EXPORT.get(ch, ch) for ch in (s or '').lower()))


def trim_to_brand(name, dom_label):
    """«GloraX Парголово» -> «GloraX»: убрать хвост-проект после бренда.

    Имя выбрано по совпадению с доменом, значит бренд — это те первые слова,
    которые складываются в метку домена. Всё, что после, — название ЖК/района.

    Набираем слова, пока склейка остаётся началом метки домена, и режем на
    точном совпадении. Останавливаться на первом частичном нельзя: у
    «Setl Estate» + setlestate первое слово уже даёт префикс «setl», но бренд
    здесь — оба слова.
    """
    target = _slug(dom_label)
    words = name.split() if name else []
    if not target or len(words) <= 1:
        return name
    joined = ''
    for i, w in enumerate(words):
        joined += _slug(w)
        if joined == target:
            return ' '.join(words[:i + 1])
        if not target.startswith(joined):
            break
    return name


RU2LAT_EXPORT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
}


def clean_site(website, domain):
    """Канонический адрес без utm-меток из 2GIS."""
    if domain:
        return 'https://' + domain
    w = (website or '').strip()
    return w.split('?')[0] if w else ''


def brand_from_title(title):
    """Осторожно вытащить бренд из <title>. Пусто, если уверенности нет."""
    if not title:
        return ''
    m = QUOTED.search(title)
    if m:
        cand = m.group(1).strip()
        if 2 <= len(cand) <= 40:
            return cand
    parts = [p.strip() for p in SEP.split(title) if p.strip()]
    if parts:
        first = parts[0]
        # заголовок-предложение («Купить квартиру в ...») брендом не является
        if len(first) <= 35 and len(first.split()) <= 4 and not re.search(
                r'купить|продаж|квартир|новостро|официальн|главная|строительство'
                r'|дома|цены|каталог|услуги', first, re.I):
            return first
    return ''


def main():
    companies = {c['key']: c for c in
                 (json.loads(l) for l in
                  open(os.path.join(HERE, 'companies.jsonl'), encoding='utf-8'))}
    crawl = {}
    path = os.path.join(HERE, 'crawl.jsonl')
    if os.path.exists(path):
        for line in open(path, encoding='utf-8'):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            crawl[r['key']] = r
    mx = {}
    mxp = os.path.join(HERE, 'mx.json')
    if os.path.exists(mxp):
        mx = json.load(open(mxp, encoding='utf-8'))
    print(f'компаний: {len(companies)}, обойдено сайтов: {len(crawl)}, '
          f'проверено MX: {len(mx)}')

    # Домен без MX и без A почту не примет — такой адрес это гарантированный
    # bounce, в базу для рассылки он попасть не должен.
    DEAD = {'nxdomain', 'no-a', 'no-ns'}

    def mail_deliverable(email):
        rec = mx.get(email.rsplit('@', 1)[-1])
        if rec is None:
            return True          # не проверяли — не выбрасываем
        return rec['mx'] or rec['note'] not in DEAD

    def mx_label(email):
        rec = mx.get(email.rsplit('@', 1)[-1])
        if rec is None:
            return ''
        return (rec['host'] or 'MX') if rec['mx'] else rec['note']

    rows = []
    stat = Counter()
    for key, c in companies.items():
        cr = crawl.get(key, {})
        stat['обойдено'] += bool(cr)
        stat['сайт жив'] += bool(cr.get('ok'))

        # ---- почта: из 2GIS + с сайта
        emails = {e for e in set(c['emails']) | set(cr.get('emails') or [])
                  if not L.is_junk_email(e) and mail_deliverable(e)}
        dom = c['domain']

        def own_domain(email):
            # именно свой домен или его поддомен: голый endswith посчитал бы
            # «своим» и notbrusnika.ru для brusnika.ru
            d = email.rsplit('@', 1)[-1]
            return bool(dom) and (d == dom or d.endswith('.' + dom))

        corporate = sorted(e for e in emails if own_domain(e))
        free = sorted(e for e in emails if e.split('@')[1] in L.FREE_MAIL)
        other = sorted(e for e in emails if e not in corporate and e not in free)
        ranked = []
        for e, kind in ([(e, 'corporate') for e in corporate]
                        + [(e, 'other-domain') for e in other]
                        + [(e, 'free-mail') for e in free]):
            r, label = rank_inbox(e.split('@')[0])
            bonus = {'corporate': 100, 'other-domain': 50, 'free-mail': 40}[kind]
            ranked.append((bonus + r, e, kind, label))
        ranked.sort(key=lambda x: (-x[0], x[1]))

        # ---- название
        name = c['name']
        dom_label = dom.split('.')[0] if dom else ''
        if c['name_src'] == 'domain-match':
            # обрезаем хвост-проект: «GloraX Парголово» -> «GloraX»
            name = trim_to_brand(name, dom_label)
        elif c['name_src'] == 'derived-from-domain':
            # плейсхолдер из домена — пробуем бренд из <title> сайта
            b = brand_from_title(cr.get('title', ''))
            if b:
                name = b

        best = ranked[0] if ranked else None
        rows.append({
            'c': c, 'cr': cr, 'name': name, 'ranked': ranked, 'best': best,
            'emails': emails,
        })

    # ---- глобальный дедуп: один email не должен уйти в базу дважды
    rows.sort(key=lambda r: -r['c']['score'])
    used = set()
    for r in rows:
        r['final'] = None
        for _, e, kind, label in r['ranked']:
            if e in used:
                continue
            used.add(e)
            r['final'] = (e, kind, label)
            break

    def base_row(r):
        c, cr = r['c'], r['cr']
        e, kind, label = r['final']
        extra = [x[1] for x in r['ranked'] if x[1] != e][:4]
        return {
            'company': r['name'],
            'email': e,
            'email_type': kind,
            'inbox_role': label,
            'mx': mx_label(e),
            'emails_extra': '; '.join(extra),
            'website': clean_site(c['website'], c['domain']),
            'domain': c['domain'],
            'inn': '; '.join((cr.get('inn') or [])[:2]),
            'city': c['primary_city'],
            'cities': '; '.join(c['cities'][:6]),
            'objects_2gis': c['cards'],
            'size_band': c.get('size_band', ''),
            'segment': segment_of(c['subcats']),
            'tier': f"T{c['tier']}",
            'score': c['score'],
            'phone': '; '.join('+' + p for p in c['phones'][:3]),
            'rubrics': '; '.join(c['subcats'][:8]),
            'score_reasons': '; '.join(c['why']),
            'site_title': cr.get('title', ''),
            'gis_ids': '; '.join(c['card_ids'][:3]),
        }

    # Основная база — только ICP-рубрики. T3 (дачи, бани, ремонт квартир,
    # дизайн интерьеров, агентства недвижимости) это B2C и микробизнес: СЭД за
    # 3-5 млн они не купят, их наличие в базе только жжёт репутацию домена.
    icp = [r for r in rows if r['c']['tier'] in (1, 2)]
    with_mail = [r for r in icp if r['final']]
    icp_no_mail = [r for r in icp if not r['final']]
    off_icp_with_mail = [r for r in rows
                         if r['c']['tier'] == 3 and r['final']]

    cols = list(base_row(with_mail[0]).keys()) if with_mail else []
    out1 = os.path.join(HERE, 'alial_construction_base.csv')
    with open(out1, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=';')
        w.writeheader()
        for r in with_mail:
            w.writerow(base_row(r))

    out2 = os.path.join(HERE, 'alial_construction_no_email.csv')
    with open(out2, 'w', encoding='utf-8-sig', newline='') as f:
        cols2 = ['company', 'website', 'domain', 'city', 'objects_2gis',
                 'segment', 'tier', 'score', 'phone', 'rubrics', 'crawl_err']
        w = csv.DictWriter(f, fieldnames=cols2, delimiter=';')
        w.writeheader()
        for r in icp_no_mail:
            c = r['c']
            w.writerow({
                'company': r['name'], 'website': clean_site(c['website'], c['domain']),
                'domain': c['domain'], 'city': c['primary_city'],
                'objects_2gis': c['cards'], 'segment': segment_of(c['subcats']),
                'tier': f"T{c['tier']}", 'score': c['score'],
                'phone': '; '.join('+' + p for p in c['phones'][:3]),
                'rubrics': '; '.join(c['subcats'][:8]),
                'crawl_err': r['cr'].get('err', 'не обходился'),
            })

    # Отсечённое не выбрасываем молча: пусть лежит отдельно и видно, что это.
    out3 = os.path.join(HERE, 'alial_construction_off_icp.csv')
    with open(out3, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=';')
        w.writeheader()
        for r in off_icp_with_mail:
            w.writerow(base_row(r))

    print(f'\nбаза с email (ICP): {len(with_mail)}  -> {os.path.basename(out1)}')
    print(f'ICP без email:      {len(icp_no_mail)} -> {os.path.basename(out2)}')
    print(f'вне ICP, с email:   {len(off_icp_with_mail)} -> {os.path.basename(out3)}')
    write_report(rows, with_mail, icp_no_mail, off_icp_with_mail, crawl, companies)
    return rows, with_mail, icp_no_mail


def write_report(rows, with_mail, icp_no_mail, off_icp_with_mail, crawl,
                 companies):
    icp = [r for r in rows if r['c']['tier'] in (1, 2)]
    live = sum(1 for r in crawl.values() if r.get('ok'))
    errs = Counter(r.get('err') or 'ok' for r in crawl.values())

    def dist(items, keyfn, top=None):
        c = Counter(keyfn(r) for r in items)
        return c.most_common(top)

    lines = []
    a = lines.append
    a('# База строительных компаний под Alial Group (Directum RX)\n')
    a('Источник: выгрузка 2GIS «Строительство / Недвижимость / Ремонт», '
      'Россия, 19.08.2026.\n')

    a('## Воронка\n')
    a('| Шаг | Осталось |')
    a('|---|---:|')
    a(f'| Карточек в исходной выгрузке | 28 416 |')
    a(f'| Компаний после схлопывания дублей | {len(companies)} |')
    a(f'| В ICP-рубриках (T1+T2) | {len(icp)} |')
    a(f'| Сайтов обойдено | {len(crawl)} |')
    a(f'| Сайт ответил | {live} |')
    a(f'| **Компаний с email — итоговая база** | **{len(with_mail)}** |')
    a(f'| ICP-компаний без email (телефон/сайт есть) | {len(icp_no_mail)} |')
    a('')

    a('## Итоговая база: срезы\n')
    a('### По сегменту')
    a('| Сегмент | Компаний |')
    a('|---|---:|')
    for k, v in dist(with_mail, lambda r: segment_of(r['c']['subcats'])):
        a(f'| {k} | {v} |')
    a('')

    a('### По типу ящика (для выбора шаблона письма)')
    a('| Тип | Компаний |')
    a('|---|---:|')
    for k, v in dist(with_mail, lambda r: r['final'][1]):
        a(f'| {k} | {v} |')
    a('')
    a('| Роль ящика | Компаний |')
    a('|---|---:|')
    for k, v in dist(with_mail, lambda r: r['final'][2]):
        a(f'| {k} | {v} |')
    a('')

    a('### По городу (топ-20)')
    a('| Город | Компаний |')
    a('|---|---:|')
    for k, v in dist(with_mail, lambda r: r['c']['primary_city'] or '—', 20):
        a(f'| {k} | {v} |')
    a('')

    a('### По полосе размера (объектов в 2GIS — прокси масштаба)')
    a('| Полоса | Компаний |')
    a('|---|---:|')
    order = ['целевой (10-29)', 'целевой (5-9)', 'крупный (30-99)',
             'малый (2-4)', 'enterprise (100+)', 'один объект']
    bc = Counter(r['c'].get('size_band', '') for r in with_mail)
    for lab in order:
        if bc.get(lab):
            a(f'| {lab} | {bc[lab]} |')
    a('')

    a('## Что осталось за бортом и почему\n')
    t3 = [r for r in rows if r['c']['tier'] == 3]
    a(f'- **{len(t3)} компаний в рубриках вне ICP** — дачи/коттеджи, бани, '
      'ремонт квартир, дизайн интерьеров, ландшафт, агентства недвижимости. '
      'Это микробизнес и B2C: СЭД за 3-5 млн ₽ они не покупают. '
      f'Те из них, у кого нашлась почта ({len(off_icp_with_mail)}), лежат в '
      '`alial_construction_off_icp.csv` — отдельно, не в основной базе.')
    a(f'- **{len(icp_no_mail)} ICP-компаний без email** — почта не нашлась ни в '
      '2GIS, ни на сайте. Лежат отдельным файлом: по ним есть телефон и сайт.')
    a('')
    a('### Почему не удалось снять почту')
    a('| Причина | Доменов |')
    a('|---|---:|')
    for k, v in errs.most_common(12):
        if k != 'ok':
            a(f'| {k} | {v} |')
    a('')

    a('## Ограничения\n')
    a('- **Размер компании не проверен по реестрам.** В 2GIS нет ни выручки, '
      'ни штата. Прокси масштаба — число объектов компании в 2GIS и число '
      'городов присутствия. Под ICP брифа (50-50 000 сотрудников, 25-200 '
      'пользователей) это оценка, а не факт.')
    inn = sum(1 for r in with_mail if (r['cr'].get('inn') or []))
    a(f'- С сайтов удалось снять **ИНН у {inn} компаний** из итоговой базы. '
      'По ним фильтр по выручке через ФНС можно сделать сразу, без резолва '
      'по названию.')
    a('- Часть крупных сайтов (ПИК, Самолёт, ЛСР) закрыта антиботом или '
      'рендерится на JS — почта с них не снялась. Такие домены видны в файле '
      'без email по колонке `crawl_err`.')

    path = os.path.join(HERE, 'report.md')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'отчёт -> {os.path.basename(path)}')


if __name__ == '__main__':
    main()
