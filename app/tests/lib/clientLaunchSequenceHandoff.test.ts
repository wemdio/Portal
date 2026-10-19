import { buildSequenceHandoffSteps } from '@/lib/clientLaunch/sequenceHandoff';
import {
  clientLaunchStepsToCampaignSequences,
  editableStepsFromCampaignSteps,
} from '@/lib/clientLaunch/campaignSequences';
import { toInstantlyHtmlBody } from '@/lib/clientLaunch/buildCampaignPayload';

const L = (subject: string, body: string, wait_days = 2) => ({ subject, body, wait_days });

describe('buildSequenceHandoffSteps', () => {
  it('пустая цепочка → []', () => {
    expect(buildSequenceHandoffSteps([])).toEqual([]);
  });

  it('сохраняет пары тема/текст и интервалы при переносе, отправке и повторном открытии редактора', () => {
    const letters = [
      L('Тема 1', 'Первое письмо\n\nС уважением, команда', 0),
      L('Тема 2', 'Второе письмо', 7),
      L('Тема 3', 'Третье письмо', 7),
      L('Тема 4', 'Четвёртое письмо', 2),
    ];
    const steps = buildSequenceHandoffSteps(letters);
    expect(steps).toEqual(letters);
    expect(steps.every((step) => !step.variants?.length)).toBe(true);

    const payload = clientLaunchStepsToCampaignSequences(steps, { bodyFormatter: toInstantlyHtmlBody })!;
    expect(payload[0].steps.map((step) => step.delay)).toEqual([7, 7, 2, 1]);
    // The provider's GET response omits the default day unit.
    const returned = payload[0].steps.map(({ delay_unit: _unit, ...step }) => step);
    expect(editableStepsFromCampaignSteps(returned)).toEqual(letters);
    expect(clientLaunchStepsToCampaignSequences(editableStepsFromCampaignSteps(returned), {
      bodyFormatter: toInstantlyHtmlBody,
    })).toEqual(payload);
  });

  it('не обрезает темы длинной цепочки до лимита A/B-вариантов', () => {
    const letters = Array.from({ length: 6 }, (_, i) => L(`T${i + 1}`, `B${i + 1}`, i === 0 ? 0 : 2));
    expect(buildSequenceHandoffSteps(letters)).toEqual(letters);
  });

  it('оставляет повторяющиеся темы у соответствующих писем', () => {
    const letters = [L('Одна тема', 'B1', 0), L('Одна тема', 'B2', 2)];
    expect(buildSequenceHandoffSteps(letters)).toEqual(letters);
  });

  it('сохраняет явно пустую тему продолжения, не подменяя первую тему последующей', () => {
    expect(buildSequenceHandoffSteps([L('   ', 'B1', 0), L('Тема 2', 'B2', 2), L('', 'B3', 3)]))
      .toEqual([L('', 'B1', 0), L('Тема 2', 'B2', 2), L('', 'B3', 3)]);
  });

  it('первое письмо отправляется сразу, отсутствующий интервал продолжения получает 2 дня', () => {
    expect(buildSequenceHandoffSteps([
      L('T', 'B', 5), { subject: null, body: 'Follow-up' }, L('Last', 'Body', -1),
    ])).toEqual([L('T', 'B', 0), L('', 'Follow-up', 2), L('Last', 'Body', 0)]);
  });
});

describe('editableStepsFromCampaignSteps', () => {
  it('сохраняет ручные варианты и скрытые ссылки при повторном сохранении', () => {
    const original = [{
      subject: 'A', body: 'Текст\n\n[Каталог](https://example.com/?a=1&b=2)', wait_days: 0,
      variants: [{ subject: 'B', body: 'Другой текст\nВторая строка' }],
    }, { subject: '', body: 'Продолжение', wait_days: 3 }];
    const payload = clientLaunchStepsToCampaignSequences(original, { bodyFormatter: toInstantlyHtmlBody })!;
    expect(editableStepsFromCampaignSteps(payload[0].steps)).toEqual(original);
  });

  it('использует предыдущую задержку, а не терминальную задержку самого письма', () => {
    const editable = editableStepsFromCampaignSteps([
      { delay: 7, delay_unit: 'days', variants: [{ subject: 'First', body: 'First' }] },
      { delay: 2, variants: [{ subject: 'Second', body: 'Second' }] },
      { delay: 1, variants: [{ subject: 'Third', body: 'Third' }] },
    ]);
    expect(editable.map((s) => s.wait_days)).toEqual([0, 7, 2]);
  });

  it('не принимает явно заданные часы за дни и поддерживает legacy wait_days', () => {
    const editable = editableStepsFromCampaignSteps([
      { delay: 12, delay_unit: 'hours', subject: 'First', body: 'First' },
      { wait_days: 3, subject: 'Second', body: 'Second' },
    ]);
    expect(editable.map((s) => s.wait_days)).toEqual([0, 3]);
  });
});
