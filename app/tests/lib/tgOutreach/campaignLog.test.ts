/** @jest-environment node */

/**
 * Подписи, которыми передача называется в журнале и на экране. Строк про одну
 * передачу набирается пять — от нажатия кнопки до отправки, — и по ним человек
 * ищет глазами конкретного собеседника. Разнобой в имени сделал бы поиск
 * бесполезным.
 */

import { forwardKindLabel, forwardWho } from '@/lib/tgOutreach/campaignLog';

describe('forwardKindLabel', () => {
  it('называет вид по-русски', () => {
    expect(forwardKindLabel('lead')).toBe('лид');
    expect(forwardKindLabel('partner')).toBe('кандидат в партнёры');
  });

  it('неизвестный вид не превращает строку в «undefined»', () => {
    expect(forwardKindLabel('что-то новое')).toBe('лид');
  });
});

describe('forwardWho', () => {
  it('юзернейм приводит к одному виду — с «@» и без дублей', () => {
    expect(forwardWho('@Ivanov', 777)).toBe('@Ivanov');
    expect(forwardWho('Ivanov', 777)).toBe('@Ivanov');
    expect(forwardWho('  Ivanov  ', 777)).toBe('@Ivanov');
  });

  it('без юзернейма показывает id — по нему собеседника ещё можно найти', () => {
    expect(forwardWho(null, 777)).toBe('ID 777');
    expect(forwardWho('   ', 777)).toBe('ID 777');
  });

  it('нет ни того, ни другого — говорим прямо, а не пустой строкой', () => {
    expect(forwardWho(null, null)).toBe('без юзернейма');
  });
});
