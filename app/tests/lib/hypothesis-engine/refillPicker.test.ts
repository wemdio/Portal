/**
 * Tests for pickRefillTemplate (baseCollectRefill): при сплите запуска по
 * сегментам долив обязан идти в ОСНОВНУЮ кампанию (segment=null), а не в
 * сегментную — новые лиды refill по сегментам не классифицированы.
 */

import { pickRefillTemplate } from '@/lib/hypothesisEngine/stages/baseCollectRefill';

function tpl(launchInfo: unknown, createdAt = '2026-08-01T00:00:00Z') {
  return {
    vertical_id: 'v1',
    created_at: createdAt,
    launch_info: launchInfo,
    personalization_plan: { operator_mapping: [] },
  };
}

describe('pickRefillTemplate — segment-split launches', () => {
  it('picks the main (segment=null) campaign out of campaigns[], not the segment one', () => {
    const pick = pickRefillTemplate(
      [
        tpl({
          // Скаляр указывает на первую созданную кампанию; при пустой
          // default-группе это может быть сегментная — её выбирать нельзя.
          campaign_id: 'camp-segment',
          campaign_name: 'HE · base · вне Москвы',
          campaign_url: '',
          leads_count: 10,
          preset_id: 'preset-1',
          created_at: '2026-08-01T00:00:00Z',
          campaigns: [
            { campaign_id: 'camp-segment', campaign_name: '', campaign_url: '', segment: 'вне Москвы', leads_count: 10 },
            { campaign_id: 'camp-main', campaign_name: '', campaign_url: '', segment: null, leads_count: 5 },
          ],
        }),
      ],
      null,
    );
    expect(pick?.campaignId).toBe('camp-main');
  });

  it('legacy scalar (no campaigns[]) still wins', () => {
    const pick = pickRefillTemplate(
      [tpl({ campaign_id: 'camp-legacy', campaign_name: '', campaign_url: '', leads_count: 3, preset_id: 'p', created_at: '2026-08-01T00:00:00Z' })],
      null,
    );
    expect(pick?.campaignId).toBe('camp-legacy');
  });

  it('preferredCampaignId matches inside campaigns[] too', () => {
    const pick = pickRefillTemplate(
      [
        tpl({
          campaign_id: 'camp-scalar',
          campaign_name: '',
          campaign_url: '',
          leads_count: 1,
          preset_id: 'p',
          created_at: '2026-08-01T00:00:00Z',
          campaigns: [
            { campaign_id: 'camp-main', campaign_name: '', campaign_url: '', segment: null, leads_count: 1 },
          ],
        }),
      ],
      'camp-main',
    );
    expect(pick?.campaignId).toBe('camp-main');
  });
});
