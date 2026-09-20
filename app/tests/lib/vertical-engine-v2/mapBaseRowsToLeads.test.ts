/** @jest-environment node */

/**
 * Превращение строк готовой базы в лиды Instantly. До этих тестов модуль не был
 * покрыт вовсе, хотя именно он решает, какое значение уедет в {{companyName}}
 * в письме клиенту.
 */
import { mapBaseRowsToLeads } from '@/lib/verticalEngineV2/launchHandoff';
import { mapOperatorsToColumns } from '@/lib/verticalEngineV2/letterPersonalization';
import { VE_COMPANY_NAME_FIELD } from '@/lib/verticalEngineV2/companyNames';
import type { VeOperatorMapping } from '@/lib/verticalEngineV2/types';

const COLUMNS = ['company', 'website', 'phone', 'email', 'vacancy_title'];
const SOURCE = 'ООО "Ромашка"', SITE = 'romashka.ru';
/** Метаданные очистки названия привязаны к исходной паре company+website. */
const cleanedName = { version: 1 as const, source: SOURCE, website: SITE, status: 'ready' as const, value: 'Ромашка' };
const row = (over: Record<string, unknown> = {}) => ({
  company: SOURCE, website: SITE, phone: '+7 999 000-00-00',
  email: 'info@romashka.ru', vacancy_title: 'Менеджер по продажам',
  [VE_COMPANY_NAME_FIELD]: cleanedName, ...over,
});
const matched = (operator: string, column: string, fallback?: string): VeOperatorMapping =>
  ({ operator, column, matched: true, ...(fallback === undefined ? {} : { fallback }) });

describe('mapBaseRowsToLeads', () => {
  it('отдаёт переменную под тем написанием, которое специалист написал в письме', () => {
    const { leads, emailColumn } = mapBaseRowsToLeads({
      rows: [row()], columns: COLUMNS, operatorMapping: mapOperatorsToColumns(['companyName'], COLUMNS),
    });
    expect(emailColumn).toBe('email');
    // Значение — очищенное название, а не сырое «ООО "Ромашка"».
    expect(leads[0].custom_variables?.companyName).toBe('Ромашка');
    // Колонку занял оператор: под собственным именем она больше не дублируется.
    expect(leads[0].custom_variables?.company).toBeUndefined();
    // Незанятые колонки по-прежнему едут под своими именами.
    expect(leads[0].custom_variables?.vacancy_title).toBe('Менеджер по продажам');
  });

  it('заполняет ОБА оператора, если они указывают на одну колонку', () => {
    // Промпты Движка пишут {{company}}, регламент учит писать {{companyName}};
    // в одном шаблоне оказываются оба, и оба матчатся на колонку company.
    const mapping = mapOperatorsToColumns(['company', 'companyName'], COLUMNS);
    expect(mapping.every((m) => m.matched && m.column === 'company')).toBe(true);
    const { leads } = mapBaseRowsToLeads({ rows: [row()], columns: COLUMNS, operatorMapping: mapping });
    // До исправления второй оператор уходил пустой строкой, а превью показывало его заполненным.
    expect(leads[0].custom_variables).toEqual(expect.objectContaining({ company: 'Ромашка', companyName: 'Ромашка' }));
  });

  it('пустая ячейка даёт пустую строку или fallback, но никогда литерал {{var}}', () => {
    const legacy = { company: '', website: '', phone: '', email: 'a@b.ru', vacancy_title: '' };
    const { leads } = mapBaseRowsToLeads({
      rows: [legacy], columns: COLUMNS,
      operatorMapping: [matched('companyName', 'company'), matched('position', 'vacancy_title', 'вашей команде')],
    });
    expect(leads[0].custom_variables?.companyName).toBe('');
    expect(leads[0].custom_variables?.position).toBe('вашей команде');
  });

  it('заполняет штатные поля Instantly, чтобы у лида не были пустыми Company Name и Website', () => {
    const { leads } = mapBaseRowsToLeads({ rows: [row()], columns: COLUMNS });
    expect(leads[0]).toEqual(expect.objectContaining({
      email: 'info@romashka.ru', company_name: 'Ромашка', website: 'romashka.ru', phone: '+7 999 000-00-00',
    }));
  });

  it('не отправляет строку авто-базы с непроверенным названием компании', () => {
    const rows = [row(), row({ email: 'x@y.ru', [VE_COMPANY_NAME_FIELD]: { ...cleanedName, status: 'failed' as const, value: '' } })];
    const { leads, leadRowIndices } = mapBaseRowsToLeads({ rows, columns: COLUMNS });
    expect(leads.map((lead) => lead.email)).toEqual(['info@romashka.ru']);
    expect(leadRowIndices).toEqual([0]);
    // Загруженная база без служебного поля проходит целиком — старые базы не переинтерпретируем.
    const uploaded = [{ company: 'Ромашка', email: 'x@y.ru' }];
    expect(mapBaseRowsToLeads({ rows: uploaded, columns: ['company', 'email'] }).leads).toHaveLength(1);
  });

  it('дедуплицирует адреса и пропускает мусорные', () => {
    const rows = [row(), row({ email: 'INFO@romashka.ru' }), row({ email: 'не почта' })];
    const { leads } = mapBaseRowsToLeads({ rows, columns: COLUMNS });
    expect(leads.map((lead) => lead.email)).toEqual(['info@romashka.ru']);
  });
});
