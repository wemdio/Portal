/** @jest-environment node */

/**
 * Разбор тела запроса к ручкам календаря технички.
 *
 * Всё, что бросает `ValidationError`, ручка обязана отдавать как 400: битый
 * ввод — это ответ пользователю, а не пятисотка. Тест держит границу: сюда
 * приходят любые данные из браузера, и ни одно поле не должно доехать до
 * запроса в базу непроверенным.
 */

import { ValidationError, parseCreateInput, parsePatchInput, parseRenewInput, parseDecisionInput } from '@/lib/techCalendar/validate';

describe('parseCreateInput', () => {
  it('принимает полную карточку', () => {
    expect(
      parseCreateInput({
        service_name: '  Bright Data ',
        service_type: 'proxy',
        amount: 250,
        currency: 'USD',
        billing_cycle: 'monthly',
        next_billing_date: '2026-08-20',
        notes: 'резидентские',
      }),
    ).toEqual({
      service_name: 'Bright Data',
      service_type: 'proxy',
      amount: 250,
      currency: 'USD',
      billing_cycle: 'monthly',
      next_billing_date: '2026-08-20',
      notes: 'резидентские',
    });
  });

  it('требует название', () => {
    expect(() => parseCreateInput({ service_name: '   ', next_billing_date: '2026-08-20' }))
      .toThrow(ValidationError);
  });

  it('отвергает неизвестный тип сервиса', () => {
    expect(() =>
      parseCreateInput({ service_name: 'X', service_type: 'vpn', next_billing_date: '2026-08-20' }),
    ).toThrow('Неизвестный тип сервиса');
  });

  it('отвергает третью валюту', () => {
    expect(() =>
      parseCreateInput({ service_name: 'X', currency: 'EUR', next_billing_date: '2026-08-20' }),
    ).toThrow('Валюта может быть только RUB или USD');
  });

  it('отвергает битую дату', () => {
    expect(() => parseCreateInput({ service_name: 'X', next_billing_date: '20.08.2026' }))
      .toThrow('Дата в формате ГГГГ-ММ-ДД');
  });

  it('отвергает несуществующую дату', () => {
    expect(() => parseCreateInput({ service_name: 'X', next_billing_date: '2026-02-31' }))
      .toThrow('Такой даты не существует');
  });

  it('отвергает отрицательную сумму', () => {
    expect(() =>
      parseCreateInput({ service_name: 'X', amount: -5, next_billing_date: '2026-08-20' }),
    ).toThrow('Сумма не может быть отрицательной');
  });

  it('подставляет значения по умолчанию', () => {
    expect(parseCreateInput({ service_name: 'X', next_billing_date: '2026-08-20' })).toEqual({
      service_name: 'X',
      service_type: 'other',
      amount: 0,
      currency: 'RUB',
      billing_cycle: 'monthly',
      next_billing_date: '2026-08-20',
      notes: null,
    });
  });
});

describe('parsePatchInput', () => {
  it('берёт только переданные поля', () => {
    expect(parsePatchInput({ amount: 300 })).toEqual({ amount: 300 });
  });

  it('отвергает пустое тело', () => {
    expect(() => parsePatchInput({})).toThrow('Нечего менять');
  });

  it('проверяет переданные поля так же строго', () => {
    expect(() => parsePatchInput({ currency: 'EUR' })).toThrow(ValidationError);
  });
});

describe('parseRenewInput', () => {
  it('разрешает пустое тело — дата считается по циклу', () => {
    expect(parseRenewInput({})).toEqual({});
  });

  it('принимает ручную дату и сумму', () => {
    expect(parseRenewInput({ next_billing_date: '2026-09-25', amount: 275 })).toEqual({
      next_billing_date: '2026-09-25',
      amount: 275,
    });
  });

  it('проверяет дату', () => {
    expect(() => parseRenewInput({ next_billing_date: 'завтра' })).toThrow(ValidationError);
  });
});

describe('parseDecisionInput', () => {
  it('принимает решение с комментарием', () => {
    expect(parseDecisionInput({ decision: 'cancel', notes: 'дорого' })).toEqual({
      decision: 'cancel',
      notes: 'дорого',
    });
  });

  it('отвергает решение вне списка', () => {
    expect(() => parseDecisionInput({ decision: 'maybe' })).toThrow('Решение может быть keep или cancel');
  });
});
