/**
 * Тесты suppression-списка OutreachOS (suppression.ts + рубеж в gridMapping):
 * наши клиенты из AMO никогда не должны попадать в self-outreach.
 */

import {
  EMPTY_SUPPRESSION,
  isSuppressedCompany,
  isSuppressedLead,
  type OutreachOsSuppression,
} from '@/lib/outreachos/suppression';
import { gridToLeadPayloads } from '@/lib/outreachos/gridMapping';

const S: OutreachOsSuppression = {
  emails: new Set(['ivanov@gmail.com', 'trassa60@bk.ru']),
  domains: new Set(['agima.ru', 'fibbee.com']),
};

describe('isSuppressedLead', () => {
  it.each<[string, string, string]>([
    ['ivanov@gmail.com', '', 'точная почта на бесплатном провайдере'],
    ['IVANOV@GMAIL.COM', '', 'регистр не важен'],
    ['info@agima.ru', '', 'любой ящик на клиентском домене'],
    ['hr@promo.agima.ru', '', 'поддомен клиентского домена в почте'],
    ['contact@other.ru', 'https://agima.ru/about', 'сайт лида — клиентский домен'],
    ['contact@other.ru', 'https://www.fibbee.com', 'www не мешает'],
    ['contact@other.ru', 'shop.fibbee.com', 'поддомен сайта клиента'],
  ])('%s / %s — подавлен (%s)', (email, site) => {
    expect(isSuppressedLead(email, site, S)).toBe(true);
  });

  it.each<[string, string, string]>([
    ['petrov@gmail.com', '', 'другой адрес на gmail — провайдер НЕ заблокирован'],
    ['info@agima-group.ru', '', 'похожий, но другой домен'],
    ['sales@nordclan.com', 'https://nordclan.com', 'обычный лид'],
    ['', '', 'пустота'],
  ])('%s / %s — НЕ подавлен (%s)', (email, site) => {
    expect(isSuppressedLead(email, site, S)).toBe(false);
  });

  it('EMPTY_SUPPRESSION ничего не подавляет', () => {
    expect(isSuppressedLead('info@agima.ru', 'https://agima.ru', EMPTY_SUPPRESSION)).toBe(false);
  });
});

describe('isSuppressedCompany', () => {
  it('компания по сайту клиента отсеивается до конструктора', () => {
    expect(isSuppressedCompany('http://agima.ru', S)).toBe(true);
    expect(isSuppressedCompany('https://promo.agima.ru/x', S)).toBe(true);
    expect(isSuppressedCompany('https://webpractik.ru', S)).toBe(false);
    expect(isSuppressedCompany('', S)).toBe(false);
  });
});

describe('gridToLeadPayloads с suppression', () => {
  const header = ['Компания', 'Сайт', 'Город', 'Email', 'Email Статус'];

  it('лиды клиентов выкидываются по почте, домену почты и сайту', () => {
    const grid = [
      header,
      ['Агима', 'https://agima.ru', 'Москва', 'new-guy@agima.ru', 'ok'],
      ['Другая', 'https://other.ru', 'Москва', 'trassa60@bk.ru', 'ok'],
      ['Триасса', 'https://fibbee.com', 'Москва', 'info@else.ru', 'ok'],
      ['Норд Клан', 'https://nordclan.com', 'Ульяновск', 'sales@nordclan.com', 'ok'],
    ];
    const leads = gridToLeadPayloads(grid, S);
    expect(leads.map((l) => l.email)).toEqual(['sales@nordclan.com']);
  });

  it('без suppression-аргумента поведение прежнее (обратная совместимость)', () => {
    const grid = [
      header,
      ['Агима', 'https://agima.ru', 'Москва', 'new-guy@agima.ru', 'ok'],
    ];
    expect(gridToLeadPayloads(grid)).toHaveLength(1);
  });
});
