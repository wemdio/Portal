import type { SupabaseClient } from '@supabase/supabase-js';
import { linkLead } from '@/lib/salesAiAnalysis/linker';
import { createMockSupabase } from '../../helpers/mockSupabase';

const DAY = 24 * 3600 * 1000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

describe('linkLead: прямой линк транскриптов через transcript_amo_lead_link', () => {
  it('берёт транскрипты из прямого линка (confidence >= 0.9, completed)', async () => {
    const db = createMockSupabase({
      tables: {
        transcript_amo_lead_link: [
          { transcript_id: 'tr-1', amo_lead_id: 77, confidence: 1.0 },
          { transcript_id: 'tr-2', amo_lead_id: 77, confidence: 0.5 }, // низкая уверенность
        ],
        tg_video_transcripts: [
          { id: 'tr-1', status: 'completed', created_at: iso(1) },
          { id: 'tr-2', status: 'completed', created_at: iso(1) },
          { id: 'tr-3', status: 'completed', created_at: iso(1) }, // не линкован к лиду
        ],
        sales_chat_messages: [
          { tg_peer_id: 555, sent_at: iso(2), text: 'видели kkt63.ru' },
        ],
        tg_chat_dialogs_unused: [],
      },
    });

    const links = await linkLead(db as unknown as SupabaseClient, { id: 77, contact_tg_username: null, company_website: 'kkt63.ru' });
    // Прямой линк найден — фолббек по сайту даже не должен добавлять tr-3:
    // у сайта нет диалога, а транскриптов без tg_chat_id=555 нет.
    expect(links.transcript_ids).toEqual(['tr-1']);
  });

  it('фоллбек на поиск по сайту, когда прямого линка нет', async () => {
    const db = createMockSupabase({
      tables: {
        transcript_amo_lead_link: [],
        sales_chat_dialogs: [
          { id: 'dlg-1', tg_peer_id: 555, peer_username: 'whale', last_message_at: iso(2) },
        ],
        sales_chat_messages: [
          { dialog_id: 'dlg-1', tg_peer_id: 555, sent_at: iso(2), text: 'сайт kkt63.ru смотри' },
        ],
        tg_video_transcripts: [
          { id: 'tr-9', tg_chat_id: 555, status: 'completed', created_at: iso(1) },
        ],
      },
    });

    const links = await linkLead(db as unknown as SupabaseClient, {
      id: 78,
      contact_tg_username: 'Whale',
      company_website: 'kkt63.ru',
    });
    expect(links.dialog_id).toBe('dlg-1');
    expect(links.transcript_ids).toEqual(['tr-9']);
  });
});
