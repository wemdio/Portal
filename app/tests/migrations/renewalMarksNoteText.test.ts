import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260803_0004_renewal_marks_note_text.sql',
  ),
  'utf8',
);

describe('миграция — сигнал продлений по комментариям AMO (note_text)', () => {
  it('создаёт функцию извлечения сумм из текста комментария', () => {
    expect(SQL).toMatch(/create or replace function public\.renewal_note_amounts\(v text\)/);
    expect(SQL).toMatch(/returns numeric\[\]/);
  });

  it('поддерживает сокращённый формат «к»/«тыс», как renewal_amounts_thousands', () => {
    expect(SQL).toMatch(/\(\\d\+\(\?:\[\.,\]\\d\+\)\?\)\\s\*\(\?:к\\\.\?\|тыс\\\.\?\)/);
  });

  it('поддерживает целую сумму без сокращения («159 000» / «159000»)', () => {
    expect(SQL).toMatch(/\\d\{1,3\}\(\?: \\d\{3\}\)\+\|\\d\{4,\}/);
  });

  it('method допускает note_text в списке допустимых значений', () => {
    expect(SQL).toMatch(/check\s*\(method in \([^)]*'note_text'[^)]*\)\)/);
  });

  it('не теряет старые значения method при добавлении note_text', () => {
    for (const m of ['note_text', 'task_text', 'project_type', 'manual', 'not_renewal']) {
      expect(SQL).toContain(`'${m}'`);
    }
  });

  it('переопределяет apply_renewal_marks()', () => {
    expect(SQL).toMatch(/create or replace function public\.apply_renewal_marks\(\)/);
    expect(SQL).toMatch(/returns integer/);
  });

  it('комментарии фильтруются по note_type=common', () => {
    expect(SQL).toMatch(/nt\.note_type = 'common'/);
  });

  it('отсекает историю датой начала договорённости команды (2026-08-03)', () => {
    // Главный риск задачи: 17 исторических упоминаний «продление» на 5189
    // комментариев — почти все намерения/отказы, а не факт оплаты. Без
    // отсечки по дате наивный регэксп поймал бы их все.
    expect(SQL).toMatch(/>=\s*date\s*'2026-08-03'/);
  });

  it('текст обязан НАЧИНАТЬСЯ со слова «продление» — анкеринг к началу строки', () => {
    // Вторая независимая защита от шума: ни один из 17 исторических
    // примеров («решили не продляться», «пинг по продлению», ...) не
    // начинается с этого слова.
    expect(SQL).toMatch(/nt\.text ~\* '\^\\s\*продление'/);
  });

  it('дата продления — created_at_amo комментария, а НЕ дата платежа', () => {
    expect(SQL).toMatch(/nt\.created_at_amo at time zone 'Europe\/Moscow'/);
  });

  it('сумма из текста сверяется с суммой платежа через ANY по массиву', () => {
    expect(SQL).toMatch(/c\.amount = any \(amt\.arr\)/);
  });

  it('окно совпадения по дате — ±14 дней, как у сигнала «текст задачи»', () => {
    expect(SQL).toMatch(/<= 14/);
  });

  it('неоднозначные кандидаты (несколько комментариев) не выбираются автоматом', () => {
    expect(SQL).toMatch(/note_ranked as \(/);
    expect(SQL).toMatch(/from note_ranked\s+where n = 1/);
  });

  it('приоритет: комментарий исключает задачу из подтверждения того же платежа', () => {
    expect(SQL).toMatch(
      /not exists\s*\(\s*select 1 from note_confirmed nc where nc\.transaction_id = tr\.transaction_id\s*\)/,
    );
  });

  it('приоритет: и комментарий, и задача исключают project_type от того же платежа', () => {
    expect(SQL).toMatch(
      /not exists\s*\(\s*select 1 from task_confirmed tc where tc\.transaction_id = pr\.transaction_id\s*\)/,
    );
    expect(SQL).toMatch(
      /not exists\s*\(\s*select 1 from note_confirmed nc where nc\.transaction_id = pr\.transaction_id\s*\)/,
    );
  });

  it('resolved объединяет три сигнала через union all с method note_text первым', () => {
    const resolvedMatch = SQL.match(/resolved as \(([\s\S]*?)\)\n\n\s*insert into/);
    expect(resolvedMatch).not.toBeNull();
    const resolvedBody = resolvedMatch![1];
    const noteIdx = resolvedBody.indexOf("'note_text'");
    const taskIdx = resolvedBody.indexOf("'task_text'");
    const projectIdx = resolvedBody.indexOf("'project_type'");
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(noteIdx);
    expect(projectIdx).toBeGreaterThan(taskIdx);
  });

  it('защита ручного решения не изменилась: manual и not_renewal защищены вместе', () => {
    expect(SQL).toMatch(
      /where[\s\S]{0,200}method\s+not in\s*\(\s*'manual'\s*,\s*'not_renewal'\s*\)/i,
    );
  });

  it('не оставляет старое одиночное условие method <> \'manual\' без not_renewal', () => {
    const updateClauses = SQL.match(/on conflict[\s\S]*?where[^;]*;/gi) ?? [];
    expect(updateClauses.length).toBeGreaterThan(0);
    for (const clause of updateClauses) {
      expect(clause).not.toMatch(/method\s*<>\s*'manual'\s*;/i);
    }
  });

  it('пересоздаёт CHECK method (drop if exists перед add — идемпотентность миграции)', () => {
    expect(SQL).toMatch(/drop constraint if exists renewal_marks_method_check/);
    const dropIdx = SQL.indexOf('drop constraint if exists renewal_marks_method_check');
    const addIdx = SQL.indexOf('add constraint renewal_marks_method_check');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });
});
