"""Нормализация 2GIS-выгрузки: домены, названия, телефоны, email.

Пути задаются окружением:
  GIS_CSV   — исходная выгрузка 2GIS (обязательно)
  GIS_PSL   — Public Suffix List; если файла нет, скачать:
              curl -o psl.dat https://publicsuffix.org/list/public_suffix_list.dat
  GIS_WORK  — рабочий каталог для промежуточных файлов (по умолчанию — этот)
"""
import csv
import os
import re
import unicodedata
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get('GIS_WORK', HERE)
CSV_PATH = os.environ.get('GIS_CSV', os.path.join(WORK, '2gis_russia.csv'))
PSL_PATH = os.environ.get('GIS_PSL', os.path.join(WORK, 'psl.dat'))


def load_psl():
    """Public Suffix List -> set правил (ICANN + PRIVATE, без исключений)."""
    rules = set()
    for line in open(PSL_PATH, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('//'):
            continue
        rules.add(line)
    return rules


PSL = load_psl()

# Соцсети, мессенджеры, виджеты, видеохостинги, конструкторы визиток, агрегаторы
# недвижимости — это НЕ корпоративный сайт компании.
NON_CORPORATE = {
    # мессенджеры / соцсети
    't.me', 'telegram.me', 'vk.com', 'vk.link', 'vk.cc', 'ok.ru',
    'instagram.com', 'facebook.com', 'wa.me', 'api.whatsapp.com', 'whatsapp.com',
    'youtube.com', 'youtu.be', 'rutube.ru', 'dzen.ru', 'zen.yandex.ru',
    'wa.clck.bar', 'clck.ru',
    # чат-виджеты и конструкторы
    'jivo.chat', 'jivosite.ru', 'taplink.cc', 'taplink.ru', 'mssg.me',
    'linktr.ee', 'wixsite.com', 'tilda.ws', 'tilda.cc', 'nethouse.ru',
    'business.site', 'sites.google.com', 'a5.ru', 'ucoz.ru', 'narod.ru',
    # агрегаторы / порталы недвижимости и объявлений
    'pn.ru', 'avito.ru', 'cian.ru', 'domclick.ru', 'domofond.ru',
    'novostroy-m.ru', 'novostroy.su', 'restate.ru', 'move.ru', 'irr.ru',
    'youla.ru', 'flatinfo.ru', 'novostroyki.ru', 'bnmap.ru', 'nmarket.pro',
    'yandex.ru', 'maps.yandex.ru', 'google.com', '2gis.ru', 'zoon.ru',
    'blizko.ru', 'yell.ru', 'orgpage.ru', 'rusprofile.ru', 'list-org.com',
    'pulscen.ru', 'tiu.ru', 'satom.ru', 'prom.ua',
}

# Суффиксы, которых нет в PSL. Размечены вручную по поддоменам (см. отчёт):
# под каждым сидят РАЗНЫЕ юрлица, поэтому eTLD+1 должен включать поддомен.
EXTRA_SUFFIXES = frozenset({
    # региональные хостинги .ru — PSL знает только msk.ru и spb.ru
    'tomsk.ru', 'perm.ru', 'vrn.ru', 'nsk.ru', 'khv.ru', 'kirov.ru',
    'karelia.ru', 'com.ru',
    # конструкторы сайтов и франшизы, раздающие поддомены разным компаниям
    'tb.ru', '24sn.ru', 'mya5.ru', 'bitrix24site.ru', 'vladis.ru',
    'bochky.ru', 'ekosip.ru',
})
# Проверено вручную: НЕ суффиксы — это застройщики, чьи поддомены суть
# сайты собственных ЖК (brusnika.ru, rbi.ru, forma.ru, enco.ru, fsk.ru,
# uds18.ru, ilike.ru, marmax.ru, kssk.ru, atlant45.ru, sigma-group.ru,
# asset-rf.ru, idealstr.ru). Их поддомены обязаны схлопываться в одну компанию.


def registrable(host, extra_suffixes=frozenset()):
    """eTLD+1 по PSL + эмпирически найденным региональным суффиксам."""
    if not host:
        return ''
    labels = host.split('.')
    # ищем самый длинный суффикс-правило, регистрируемый домен = суффикс + 1 метка
    for i in range(len(labels)):
        candidate = '.'.join(labels[i:])
        if candidate in PSL or candidate in extra_suffixes:
            if i == 0:
                return host  # сам домен и есть суффикс — отдаём как есть
            return '.'.join(labels[i - 1:])
    # неизвестный TLD — берём последние две метки
    return '.'.join(labels[-2:]) if len(labels) >= 2 else host


def host_of(url):
    """URL -> голый хост, нижний регистр, без www и порта."""
    u = (url or '').strip().lower()
    if not u:
        return ''
    u = re.sub(r'^[a-z]+://', '', u)
    u = u.split('/')[0].split('?')[0].split('#')[0].split(':')[0]
    u = u.strip('.')
    while u.startswith('www.'):
        u = u[4:]
    return u


# ---------------------------------------------------------------- названия
LEGAL_FORMS = [
    'общество с ограниченной ответственностью', 'акционерное общество',
    'публичное акционерное общество', 'закрытое акционерное общество',
    'открытое акционерное общество', 'индивидуальный предприниматель',
    'группа компаний', 'холдинг', 'корпорация',
    'ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'гк', 'тд', 'нао',
    'сз', 'специализированный застройщик',
]

# «хвосты» 2GIS: описание рода деятельности после запятой
TAIL_RE = re.compile(
    r',\s*(строительная|проектная|инжиниринговая|девелоперская|управляющая|'
    r'изыскательская|подрядная|монтажная|торговая|производственная|'
    r'архитектурная|консалтинговая)?\s*'
    r'(компания|фирма|организация|группа компаний|холдинг|корпорация|'
    r'бюро|мастерская|студия|центр|агентство|завод|комбинат|трест|'
    r'застройщик|офис продаж|отдел продаж|представительство|филиал)\b.*$',
    re.I)


def norm_name(name):
    """Название -> сравнимая форма: без юрформы, хвостов, кавычек и регистра."""
    s = (name or '').strip().lower()
    s = s.replace('ё', 'е')
    s = TAIL_RE.sub('', s)
    s = re.sub(r'["«»\'`]', ' ', s)
    s = unicodedata.normalize('NFKC', s)
    for form in sorted(LEGAL_FORMS, key=len, reverse=True):
        s = re.sub(r'(^|\s)' + re.escape(form) + r'(\s|$)', ' ', s)
    s = re.sub(r'[^\w\s-]', ' ', s, flags=re.U)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


# ---------------------------------------------------------------- телефоны
def norm_phones(raw):
    """'+79128678937, +78212245481' -> ['79128678937', '78212245481']."""
    out = []
    for chunk in re.split(r'[,;]', (raw or '')):
        d = re.sub(r'\D', '', chunk)
        if not d:
            continue
        if len(d) == 11 and d[0] == '8':
            d = '7' + d[1:]
        if len(d) == 10:
            d = '7' + d
        if len(d) == 11 and d[0] == '7':
            out.append(d)
    return out


# ---------------------------------------------------------------- email
EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
FREE_MAIL = {
    'mail.ru', 'yandex.ru', 'ya.ru', 'gmail.com', 'bk.ru', 'inbox.ru',
    'list.ru', 'internet.ru', 'rambler.ru', 'yahoo.com', 'outlook.com',
    'hotmail.com', 'icloud.com', 'me.com', 'mail.com', 'narod.ru',
}
# ящики, которые бесполезны для outreach в ЛПР
ROLE_JUNK_LOCAL = {
    'noreply', 'no-reply', 'donotreply', 'abuse', 'postmaster', 'webmaster',
    'spam', 'hostmaster', 'root', 'admin@localhost',
}


def norm_emails(raw):
    return [m.group(0).lower() for m in EMAIL_RE.finditer(raw or '')]


# Демо-домены из шаблонов сайтов: example.ru, mysite.com, site-name.ru и т.п.
DEMO_DOMAIN = re.compile(
    r'^(example|examplе|primer|mysite|yoursite|your-site|site-name|sitename|'
    r'domain|yourdomain|your-domain|test|demo|template|shablon)\.', re.I)


def is_junk_email(email):
    """Адрес-заглушка из шаблона сайта, а не реальный контакт."""
    if '@' not in email:
        return True
    local, dom = email.rsplit('@', 1)
    if DEMO_DOMAIN.match(dom):
        return True
    if local in ROLE_JUNK_LOCAL:
        return True
    return False


def load_rows():
    f = open(CSV_PATH, encoding='utf-8-sig')
    first = f.readline()
    assert first.strip() == 'sep=;', f'неожиданная первая строка: {first!r}'
    rows = list(csv.DictReader(f, delimiter=';'))
    f.close()
    expected = ['id', 'name', 'city_name', 'geometry_name', 'post_code', 'phone',
                'email', 'website', 'vkontakte', 'instagram', 'lon', 'lat',
                'category', 'subcategory']
    assert list(rows[0].keys()) == expected, 'схема CSV изменилась'
    # 2GIS экранирует текстовые поля апострофом для Excel
    for r in rows:
        for k in ('id', 'post_code', 'phone'):
            r[k] = r[k].lstrip("'")
        r['phone'] = r['phone'].replace(", '", ', ').replace("'", '')
    return rows


def detect_regional_suffixes(rows, min_distinct_companies=3):
    """Находит псевдо-TLD вида perm.ru/vrn.ru: под ними сидят РАЗНЫЕ компании.

    PSL знает msk.ru и spb.ru, но не остальные региональные хостинги. Признак:
    у двухуровневого .ru-домена есть >=N поддоменов, и нормализованные названия
    компаний под ними различаются.
    """
    by_parent = defaultdict(lambda: defaultdict(set))
    for r in rows:
        host = host_of(r['website'])
        if not host or host in NON_CORPORATE:
            continue
        labels = host.split('.')
        if len(labels) < 3 or labels[-1] != 'ru':
            continue
        parent = '.'.join(labels[-2:])
        sub = '.'.join(labels[:-2])
        by_parent[parent][sub].add(norm_name(r['name']))

    found = {}
    for parent, subs in by_parent.items():
        if len(subs) < min_distinct_companies:
            continue
        names = set()
        for s in subs.values():
            names |= s
        names = {n for n in names if n}
        # если у поддоменов >=N разных названий — это хостинг-суффикс, не компания
        if len(names) >= min_distinct_companies:
            found[parent] = (len(subs), len(names))
    return found
