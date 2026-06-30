import {
  ANALYTICS_SERVICES,
  ANALYTICS_SERVICE_KEYS,
  ANALYTICS_SUMMARY_KEY,
  detectAnalyticsServices,
} from '@/lib/enrich/analyticsServicesDetector';

/**
 * Реалистичные сниппеты встраивания каждого сервиса. Ключ = id детектора,
 * значение = HTML, который ДОЛЖЕН триггерить именно этот сервис и НЕ триггерить
 * остальные 12. Это portировано из self-test локального скрипта
 * enrich-roistat-competitors, которым собиралась база-пример.
 */
const FIXTURES: Record<string, string> = {
  roistat: `<script src="//cdn.roistat.com/rstat.js"></script><script>var roistatProjectId='1234';</script>`,
  k50: `<script src="https://tracker.k50project.ru/track/abc.js"></script>`,
  owox_bi: `<script src="//t.owox.com/owox.js?id=foo" async></script>`,
  envybox: `<script src="//cdn.envybox.io/widget.js"></script>`,
  smartis: `<script src="https://cdn.smartis.ru/static/sm-id.js" async></script>`,
  calltouch: `<script src="//mod.calltouch.ru/init.js?id=42" async></script>`,
  comagic: `<script src="//app.comagic.ru/static/cs.js"></script>`,
  mango_office: `<script src="//widgets.mango-office.ru/calltracking.js"></script>`,
  ringostat: `<script src="//cdn.ringostat.com/static/widget.js"></script>`,
  callibri: `<script src="//cdn.callibri.ru/widget.js"></script>`,
  uiscom: `<script src="//web.uiscom.ru/widget.js"></script>`,
  primegate: `<script src="//primegate.io/p/widget.js"></script>`,
  alloka: `<script src="//cdn.alloka.ru/widget.js"></script>`,
};

describe('detectAnalyticsServices', () => {
  it('returns empty array for empty / plain HTML', () => {
    expect(detectAnalyticsServices('')).toEqual([]);
    expect(
      detectAnalyticsServices('<html><head><title>Hi</title></head><body>Foo</body></html>'),
    ).toEqual([]);
  });

  it('has a fixture for every service (no untested detector)', () => {
    for (const svc of ANALYTICS_SERVICES) {
      expect(Object.keys(FIXTURES)).toContain(svc.id);
    }
    expect(ANALYTICS_SERVICES).toHaveLength(13);
  });

  it('each fixture triggers ONLY its own service (no cross-matches)', () => {
    for (const svc of ANALYTICS_SERVICES) {
      const ids = detectAnalyticsServices(FIXTURES[svc.id]).map((d) => d.id);
      expect(ids).toEqual([svc.id]);
    }
  });

  it('does not match a brand mentioned only as prose (domain-anchored)', () => {
    // «Мы интегрируем Roistat и Calltouch» — голое упоминание не должно давать «да».
    const prose = '<p>Мы интегрируем Roistat и Calltouch под ключ.</p>';
    expect(detectAnalyticsServices(prose)).toEqual([]);
  });

  it('detects multiple services on one page, preserving canonical order', () => {
    const html = `${FIXTURES.uiscom}\n${FIXTURES.calltouch}\n${FIXTURES.callibri}`;
    const labels = detectAnalyticsServices(html).map((d) => d.label);
    // Порядок — как в ANALYTICS_SERVICES (Calltouch < Callibri < UIScom).
    expect(labels).toEqual(['Calltouch', 'Callibri', 'UIScom']);
  });

  it('ANALYTICS_SERVICE_KEYS = 13 per-service keys + the rollup key', () => {
    expect(ANALYTICS_SERVICE_KEYS.size).toBe(14);
    for (const svc of ANALYTICS_SERVICES) {
      expect(ANALYTICS_SERVICE_KEYS.has(svc.key)).toBe(true);
    }
    expect(ANALYTICS_SERVICE_KEYS.has(ANALYTICS_SUMMARY_KEY)).toBe(true);
    // svc keys are unique.
    expect(new Set(ANALYTICS_SERVICES.map((s) => s.key)).size).toBe(13);
  });
});
