/**
 * Тесты структурного B2C/ИП-отсева OutreachOS (excludeB2c.ts).
 *
 * Позитивные кейсы — реальные компании-шум из классификации первого live-прогона
 * (выборка 217/868, 05.07.2026). Негативные — реальные B2B из той же базы,
 * которые правила НЕ должны задевать (precision > recall).
 */

import {
  isPersonName,
  matchOutreachOsB2cRule,
  isOutreachOsB2cCompany,
} from '@/lib/outreachos/excludeB2c';
import { gridToLeadPayloads } from '@/lib/outreachos/gridMapping';

describe('isPersonName', () => {
  it.each([
    'Ильин Александр Павлович',
    'Кутергина Наталья Сергеевна',
    'Урина Елена Владимировна',
    'Смагина Наталья',
    'Венглинский Александр',
  ])('ФИО «%s» распознаётся', (name) => {
    expect(isPersonName(name)).toBe(true);
  });

  it.each([
    'Красный дельфин',
    'Рабочие Руки',
    'Кадры Проф',
    'Виктория Транс', // имя без фамильного суффикса второго слова — не ФИО
    'Центр Деловых Решений', // 3 слова, но последнее — не отчество
    'Первый Строительный Кирпич', // «ич» на конце ≠ отчество
    'Security Vision', // латиница — не ФИО
    'Зенит',
  ])('«%s» НЕ распознаётся как ФИО', (name) => {
    expect(isPersonName(name)).toBe(false);
  });
});

describe('matchOutreachOsB2cRule — позитивные (шум из классификации)', () => {
  it.each<[string, string, string]>([
    ['Ильин Александр Павлович', 'https://these-guys.ru', 'name:фио'],
    ['Кутергина Наталья Сергеевна', 'https://aktivrabota.tilda.ws/', 'name:фио'],
    ['ИП Иванов', '', 'name:ип'],
    ['Онлайн-школа Тетрика', 'https://tetrika-school.ru', 'name:школа'],
    ['Верона', 'http://veronaschool.ru', 'host:school'],
    ['Навигатор', 'http://www.navigator-hotel.ru', 'host:hotel'],
    ['Гранд Отель Европа', '', 'name:отель'],
    ['Студия РАДУГА фотостудия', 'http://www.photoraduga.ru', 'name:фотостудия'],
    ['ФК Зенит', '', 'name:футбольный клуб'],
    ['Московская коллегия адвокатов', 'https://tp-law.com/', 'name:коллегия адвокатов'],
    ['Издательский Дом Питер', 'http://www.piter.com', 'name:издательство'],
    ['Издательство МОЗАИКА-СИНТЕЗ', 'https://mozaikabooks.ru/', 'name:издательство'],
    ['Александр Недвижимость', 'https://anspb.ru/karera', 'name:недвижимость'],
    ['Сокровища', 'http://www.sokrov.shop', 'host:.shop'],
    ['ЭйчарОсы', 'http://project7529377.tilda.ws/', 'host:tilda'],
    ['Ресторан Прага', '', 'name:общепит'],
    ['Салон красоты Багира', '', 'name:красота/фитнес'],
    ['Турагентство Роза Ветров туроператор', '', 'name:туризм'],
    ['Ломбард Успех', '', 'name:ломбард'],
  ])('«%s» / %s → %s', (name, site, rule) => {
    expect(matchOutreachOsB2cRule(name, site)).toBe(rule);
  });

  it('ловит B2C-хост по домену ПОЧТЫ, когда сайта нет', () => {
    expect(matchOutreachOsB2cRule('Компания', '', 'shop-mebel.tilda.ws')).toBe('host:tilda');
    expect(matchOutreachOsB2cRule('Компания', '', 'sokrov.shop')).toBe('host:.shop');
  });
});

describe('matchOutreachOsB2cRule — негативные (B2B не задеваем)', () => {
  it.each<[string, string]>([
    ['Security Vision', 'https://www.securityvision.ru/'],
    ['Вебпрактик', 'http://webpractik.ru'],
    ['Норд Клан', 'https://nordclan.com/'],
    ['Гладиаторы ИБ', 'https://glabit.ru'],
    ['Кадровый Союз', 'https://p-union.ru/'],
    ['Типография Prospekt', 'https://prospekt-print.ru'], // «ип» внутри слова — не ИП
    ['Котельное оборудование Урала', 'https://kotly-ural.ru'], // «отел» внутри «котельное»
    ['Ресторатор Софт', 'https://restorator-soft.ru'], // «ресторат» ≠ «ресторан»
    ['Салон Печати', 'https://kopirkina.ru'], // «салон» без «красоты»
    ['Рабочие Руки', 'https://russian.works/'],
    ['Группа Актион', 'https://action.group'], // B2B-издатель без стоп-токена
    ['Зенит', 'http://www.fc-zenit.ru'], // без «ФК» в названии структурно не ловится — осознанно
    // Найдены как FP на прогоне полной базы 868 — правила ужесточены:
    ['Информационная группа Ресторанные ведомости', 'http://restoranoff.ru/'], // B2B-медиа
    ['Воронеж Издательско-полиграфическая Фирма', 'http://ipf-vrn.ru'], // B2B-типография
  ])('«%s» / %s остаётся', (name, site) => {
    expect(matchOutreachOsB2cRule(name, site)).toBeNull();
  });
});

describe('gridToLeadPayloads применяет B2C-отсев', () => {
  const header = ['Компания', 'Сайт', 'Город', 'Email', 'Email Статус'];

  it('B2C-строки не попадают в лиды и не занимают квоту домена', () => {
    const grid = [
      header,
      ['Верона', 'http://veronaschool.ru', 'Москва', 'info@veronaschool.ru', 'ok'],
      ['Ильин Александр Павлович', 'https://these-guys.ru', 'Москва', 'ip@these-guys.ru', 'ok'],
      ['Вебпрактик', 'http://webpractik.ru', 'Ростов', 'hello@webpractik.ru', 'ok'],
    ];
    const leads = gridToLeadPayloads(grid);
    expect(leads.map((l) => l.email)).toEqual(['hello@webpractik.ru']);
  });

  it('ловит по домену почты при пустом сайте', () => {
    const grid = [
      header,
      ['Компания Икс', '', 'Москва', 'order@mebel.shop', 'ok'],
      ['Норд Клан', 'https://nordclan.com/', 'Ульяновск', 'sales@nordclan.com', 'ok'],
    ];
    const leads = gridToLeadPayloads(grid);
    expect(leads.map((l) => l.email)).toEqual(['sales@nordclan.com']);
  });

  it('isOutreachOsB2cCompany — обёртка согласована с matchOutreachOsB2cRule', () => {
    expect(isOutreachOsB2cCompany('ИП Иванов', '')).toBe(true);
    expect(isOutreachOsB2cCompany('Вебпрактик', 'http://webpractik.ru')).toBe(false);
  });
});
