import { buildLaunchSequence } from '@/lib/verticalEngineV2/launchHandoff';
import { renderTemplatePreview } from '@/lib/verticalEngineV2/renderPreview';

describe('Vertical Engine v2 segment preview parity', () => {
  const letters = [
    {
      subject: 'Новый поток',
      body: 'Поможем привлечь больше учеников.',
      wait_days: 0,
      segment_variants: [
        {
          when: 'Медицинские клиники',
          text: 'Поможем клинике привлечь больше пациентов.',
        },
      ],
    },
  ];

  it('selects the same segment body as the launch sequence', () => {
    const preview = renderTemplatePreview({
      letters,
      operatorMapping: [],
      rows: [{ company: 'Клиника Север' }],
      columns: ['company'],
      rowSegments: ['мЕДИЦИНСКИЕ КЛИНИКИ'],
    });
    const launch = buildLaunchSequence(letters, { segmentWhen: 'Медицинские клиники' });

    expect(launch).not.toBeNull();
    expect(preview.rows[0]?.letters[0]?.body).toBe(
      launch?.steps[0]?.body,
    );
    expect(preview.rows[0]?.letters[0]?.body).toBe(
      'Поможем клинике привлечь больше пациентов.',
    );
    expect(preview.rows[0]?.letters[0]?.body).not.toContain('учеников');
  });

  it('keeps the default body when the row has no matching segment', () => {
    const preview = renderTemplatePreview({
      letters,
      operatorMapping: [],
      rows: [{ company: 'Неизвестная компания' }],
      columns: ['company'],
      rowSegments: [null],
    });
    const launch = buildLaunchSequence(letters);

    expect(preview.rows[0]?.letters[0]?.body).toBe(launch?.steps[0]?.body);
    expect(preview.rows[0]?.letters[0]?.body).toBe(
      'Поможем привлечь больше учеников.',
    );
  });
});
