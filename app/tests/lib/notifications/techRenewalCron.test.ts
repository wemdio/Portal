/** @jest-environment node */

/**
 * Напоминания о продлении технички.
 *
 * Порог намеренно короче семидневного жёлтого статуса: экран подсвечивает
 * списание заранее, а звенит портал за три дня — когда решение пора принимать.
 * Тест держит и порог, и главное свойство прогона: он идёт каждые 10 минут и
 * не имеет права слать одно и то же дважды.
 */

import { createMockSupabase } from '../../helpers/mockSupabase';
import { runTechRenewalNotifications } from '@/lib/notifications/techRenewalCron';

const ADMIN_A = 'admin-a';
const ADMIN_B = 'admin-b';
const NOW = new Date('2026-08-13T09:00:00Z');

function profiles() {
  return [
    { id: ADMIN_A, role: 'admin' },
    { id: ADMIN_B, role: 'admin' },
    { id: 'tech-1', role: 'technician' },
    { id: 'lead-1', role: 'lead' },
  ];
}

function sub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    service_name: 'Bright Data',
    amount: 250,
    currency: 'USD',
    next_billing_date: '2026-08-15',
    status: 'pending_review',
    is_hidden: false,
    ...over,
  };
}

function seed(subs: Array<Record<string, unknown>>, log: Array<Record<string, unknown>> = []) {
  return createMockSupabase({
    tables: {
      tech_subscriptions: subs,
      profiles: profiles(),
      notifications: [],
      tech_renewal_notification_log: log,
    },
  });
}

describe('runTechRenewalNotifications', () => {
  it('шлёт напоминание каждому админу и никому больше', async () => {
    const db = seed([sub()]);

    const result = await runTechRenewalNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(2);
    const notifs = db.getRows('notifications');
    expect(notifs.map((n) => n.user_id).sort()).toEqual([ADMIN_A, ADMIN_B]);
    expect(notifs[0]).toMatchObject({
      type: 'tech_renewal',
      entity_type: 'tech_subscription',
      entity_id: 'sub-1',
      is_read: false,
    });
    expect(String(notifs[0].title)).toContain('Bright Data');
  });

  it('молчит за четыре дня и звенит за три', async () => {
    const quiet = seed([sub({ next_billing_date: '2026-08-17' })]);
    expect((await runTechRenewalNotifications({ db: quiet as never, now: NOW })).created).toBe(0);

    const loud = seed([sub({ next_billing_date: '2026-08-16' })]);
    expect((await runTechRenewalNotifications({ db: loud as never, now: NOW })).created).toBe(2);
  });

  it('не шлёт второй раз при повторном прогоне', async () => {
    const db = seed([sub()]);

    await runTechRenewalNotifications({ db: db as never, now: NOW });
    const second = await runTechRenewalNotifications({ db: db as never, now: NOW });

    expect(second.created).toBe(0);
    expect(db.getRows('notifications')).toHaveLength(2);
  });

  it('в день оплаты шлёт отдельное напоминание', async () => {
    const db = seed(
      [sub({ next_billing_date: '2026-08-13' })],
      [{ subscription_id: 'sub-1', billing_date: '2026-08-13', level: 'soon' }],
    );

    const result = await runTechRenewalNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(2);
    expect(db.getRows('tech_renewal_notification_log').map((r) => r.level).sort()).toEqual(['due', 'soon']);
  });

  it('после продления напоминает заново — ключ включает дату', async () => {
    const db = seed(
      [sub({ next_billing_date: '2026-09-15' })],
      [{ subscription_id: 'sub-1', billing_date: '2026-08-15', level: 'soon' }],
    );

    const quiet = await runTechRenewalNotifications({ db: db as never, now: NOW });
    expect(quiet.created).toBe(0);

    const later = await runTechRenewalNotifications({
      db: db as never,
      now: new Date('2026-09-13T09:00:00Z'),
    });
    expect(later.created).toBe(2);
  });

  it('не напоминает про отменённые', async () => {
    const db = seed([sub({ status: 'cancel' })]);
    expect((await runTechRenewalNotifications({ db: db as never, now: NOW })).created).toBe(0);
  });

  it('не напоминает про скрытые', async () => {
    const db = seed([sub({ is_hidden: true })]);
    expect((await runTechRenewalNotifications({ db: db as never, now: NOW })).created).toBe(0);
  });

  it('напоминает про оставленные в день оплаты', async () => {
    const db = seed([sub({ status: 'keep', next_billing_date: '2026-08-13' })]);
    const result = await runTechRenewalNotifications({ db: db as never, now: NOW });
    expect(result.created).toBe(2);
    expect(String(db.getRows('notifications')[0].body)).toContain('Отметьте оплату и продлите период');
    expect(String(db.getRows('notifications')[0].body)).not.toContain('отменить');
  });

  it('просроченный сервис не звенит второй раз на ту же дату', async () => {
    const db = seed([sub({ next_billing_date: '2026-08-10' })]);

    await runTechRenewalNotifications({ db: db as never, now: NOW });
    const next = await runTechRenewalNotifications({
      db: db as never,
      now: new Date('2026-08-14T09:00:00Z'),
    });

    expect(next.created).toBe(0);
  });
});
