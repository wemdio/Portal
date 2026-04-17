import { detectSignals, determineProfile } from '@/lib/enrich/signalDetector';

describe('detectSignals', () => {
  it('returns empty array for empty HTML', () => {
    expect(detectSignals('')).toEqual([]);
  });

  it('returns empty array for plain HTML without signals', () => {
    const html = '<html><head><title>Test</title></head><body><p>Hello world</p></body></html>';
    expect(detectSignals(html)).toEqual([]);
  });

  it('detects Yandex.Metrika pixel', () => {
    const html = '<script src="https://mc.yandex.ru/metrika/tag.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'yandex_metrika')).toBe(true);
  });

  it('detects Yandex.Direct via yadro/pixel', () => {
    const html = '<script src="https://yandex.ru/ads/system/context.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'yandex_direct')).toBe(true);
  });

  it('detects VK Pixel (retargeting)', () => {
    const html = '<script>VK.Retargeting.Init("VK-RTRG-12345"); VK.Retargeting.Hit();</script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'vk_pixel')).toBe(true);
  });

  it('detects Google Ads gtag', () => {
    const html = '<script src="https://www.googletagmanager.com/gtag/js?id=AW-123"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'google_ads')).toBe(true);
  });

  it('detects Facebook Pixel', () => {
    const html = "<script>fbq('init', '123456');</script>";
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'facebook_pixel')).toBe(true);
  });

  it('detects myTarget pixel', () => {
    const html = '<script src="https://top-fwz1.mail.ru/js/code.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'mytarget')).toBe(true);
  });

  it('detects Calltouch', () => {
    const html = '<script src="https://mod.calltouch.ru/init.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'calltouch')).toBe(true);
  });

  it('detects CoMagic', () => {
    const html = '<script src="https://cdn.comagic.ru/comagic-analytic.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'comagic')).toBe(true);
  });

  it('detects Mango Office', () => {
    const html = '<script src="https://widgets.mango-office.ru/widgets/mango.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'mango_office')).toBe(true);
  });

  it('detects amoCRM', () => {
    const html = '<script src="https://cdn.amocrm.ru/js/button.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'amocrm')).toBe(true);
  });

  it('detects Bitrix24', () => {
    const html = '<script src="https://cdn.bitrix24.ru/b123/crm/tracking/call.tracker.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'bitrix24')).toBe(true);
  });

  it('detects HubSpot', () => {
    const html = '<script src="https://js.hs-scripts.com/123.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'hubspot')).toBe(true);
  });

  it('detects RetailCRM', () => {
    const html = '<script>retailcrm.chat.init()</script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'retailcrm')).toBe(true);
  });

  it('detects JivoSite', () => {
    const html = '<script src="//code.jivosite.com/widget/abc123"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'jivosite')).toBe(true);
  });

  it('detects Carrot Quest', () => {
    const html = '<script src="https://cdn.carrotquest.app/api.min.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'carrotquest')).toBe(true);
  });

  it('detects Chatra', () => {
    const html = '<script>window.ChatraID = "abc";</script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'chatra')).toBe(true);
  });

  it('detects Talk-Me', () => {
    const html = '<script src="https://lcab.talk-me.ru/support/support.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'talkme')).toBe(true);
  });

  it('detects LiveTex', () => {
    const html = '<script src="https://cdn-widgets.livetex.ru/getwidget/abc.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'livetex')).toBe(true);
  });

  it('detects WhatsApp widget', () => {
    const html = '<a href="https://wa.me/79991234567">WhatsApp</a>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'whatsapp_widget')).toBe(true);
  });

  it('detects YooKassa (YuKassa)', () => {
    const html = '<script src="https://yookassa.ru/checkout-widget/v1/checkout-widget.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'yukassa')).toBe(true);
  });

  it('detects CloudPayments', () => {
    const html = '<script src="https://widget.cloudpayments.ru/bundles/cloudpayments.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'cloudpayments')).toBe(true);
  });

  it('detects Tinkoff Pay', () => {
    const html = '<script src="https://securepay.tinkoff.ru/html/payForm/js/tinkoff_v2.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'tinkoff_pay')).toBe(true);
  });

  it('detects Robokassa', () => {
    const html = '<form action="https://auth.robokassa.ru/Merchant/Index.aspx">';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'robokassa')).toBe(true);
  });

  it('detects Stripe', () => {
    const html = '<script src="https://js.stripe.com/v3/"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'stripe')).toBe(true);
  });

  it('detects Wildberries link', () => {
    const html = '<a href="https://www.wildberries.ru/catalog/12345">Купить на WB</a>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'wildberries')).toBe(true);
  });

  it('detects Ozon link', () => {
    const html = '<a href="https://www.ozon.ru/product/12345">Ozon</a>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'ozon')).toBe(true);
  });

  it('detects Yandex Market link', () => {
    const html = '<a href="https://market.yandex.ru/product/12345">Яндекс Маркет</a>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'yandex_market')).toBe(true);
  });

  it('detects 1C mention', () => {
    const html = '<p>Интеграция с 1С-Предприятие для автоматизации учёта</p>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === '1c_erp')).toBe(true);
  });

  it('detects Unisender', () => {
    const html = '<script src="https://cdn.unisender.com/some-widget.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'unisender')).toBe(true);
  });

  it('detects Mindbox', () => {
    const html = '<script src="https://api.mindbox.ru/v3/js/operation"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'mindbox')).toBe(true);
  });

  it('detects SendPulse', () => {
    const html = '<script src="https://cdn.sendpulse.com/js/push/webpush.js"></script>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'sendpulse')).toBe(true);
  });

  it('detects hh.ru hiring link', () => {
    const html = '<a href="https://hh.ru/employer/12345">Вакансии</a>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'hiring_hh')).toBe(true);
  });

  it('detects careers page', () => {
    const html = '<a href="/careers">Карьера</a>';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'hiring_careers')).toBe(true);
  });

  it('detects Tilda CMS', () => {
    const html = '<meta name="generator" content="Tilda Publishing">';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'tilda')).toBe(true);
  });

  it('detects 1C-Bitrix CMS', () => {
    const html = '<meta name="generator" content="1C-Bitrix">';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'bitrix_cms')).toBe(true);
  });

  it('detects WordPress CMS', () => {
    const html = '<meta name="generator" content="WordPress 6.4">';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'wordpress')).toBe(true);
  });

  it('detects hreflang multilingual tag', () => {
    const html = '<link rel="alternate" hreflang="en" href="https://example.com/en/">';
    const signals = detectSignals(html);
    expect(signals.some((s) => s.id === 'multilingual')).toBe(true);
  });

  it('detects multiple signals from complex HTML', () => {
    const html = `
      <html>
        <head>
          <script src="https://mc.yandex.ru/metrika/tag.js"></script>
          <script src="//code.jivosite.com/widget/xyz"></script>
          <meta name="generator" content="Tilda Publishing">
        </head>
        <body>
          <a href="https://wa.me/79001234567">WhatsApp</a>
        </body>
      </html>
    `;
    const signals = detectSignals(html);
    const ids = signals.map((s) => s.id);
    expect(ids).toContain('yandex_metrika');
    expect(ids).toContain('jivosite');
    expect(ids).toContain('tilda');
    expect(ids).toContain('whatsapp_widget');
    expect(signals.length).toBe(4);
  });

  it('does not produce duplicates', () => {
    const html = `
      <script src="https://mc.yandex.ru/metrika/tag.js"></script>
      <script src="https://mc.yandex.ru/metrika/watch.js"></script>
    `;
    const signals = detectSignals(html);
    const metrikaCount = signals.filter((s) => s.id === 'yandex_metrika').length;
    expect(metrikaCount).toBe(1);
  });
});

describe('determineProfile', () => {
  it('returns empty string for no signals', () => {
    expect(determineProfile([])).toBe('');
  });

  it('returns "Тратит, но не считает" for ad pixels without CRM/call-tracking', () => {
    const signals = detectSignals(`
      <script src="https://mc.yandex.ru/metrika/tag.js"></script>
      <script src="https://yandex.ru/ads/system/context.js"></script>
      <script>VK.Retargeting.Init("VK-RTRG-1");</script>
    `);
    expect(determineProfile(signals)).toBe('Тратит, но не считает');
  });

  it('returns "Вырос из инструментов" for budget stack combo', () => {
    const signals = detectSignals(`
      <script src="//code.jivosite.com/widget/abc"></script>
      <script src="https://cdn.amocrm.ru/js/button.js"></script>
      <script src="https://cdn.unisender.com/widget.js"></script>
      <meta name="generator" content="Tilda Publishing">
    `);
    expect(determineProfile(signals)).toBe('Вырос из инструментов');
  });

  it('returns "Зависимость от одного канала" for only Yandex.Direct', () => {
    const signals = detectSignals(`
      <script src="https://yandex.ru/ads/system/context.js"></script>
    `);
    expect(determineProfile(signals)).toBe('Зависимость от одного канала');
  });

  it('returns "Маркетплейс-зависимый" for marketplace links without own payments', () => {
    const signals = detectSignals(`
      <a href="https://www.wildberries.ru/catalog/12345">WB</a>
      <a href="https://www.ozon.ru/product/12345">Ozon</a>
    `);
    expect(determineProfile(signals)).toBe('Маркетплейс-зависимый');
  });

  it('returns "Технически зрелый, но без маркетинга" for tech stack without marketing', () => {
    const signals = detectSignals(`
      <script src="/_next/static/chunks/main.js"></script>
      <meta name="generator" content="Next.js">
    `);
    expect(determineProfile(signals)).toBe('Технически зрелый, но без маркетинга');
  });

  it('returns "Офлайн пытается стать онлайн" for minimal online presence', () => {
    const signals = detectSignals(`
      <meta name="generator" content="Tilda Publishing">
    `);
    expect(determineProfile(signals)).toBe('Офлайн пытается стать онлайн');
  });

  it('picks most specific profile when multiple match', () => {
    const signals = detectSignals(`
      <script src="https://yandex.ru/ads/system/context.js"></script>
      <a href="https://www.wildberries.ru/catalog/12345">WB</a>
    `);
    const profile = determineProfile(signals);
    expect(typeof profile).toBe('string');
    expect(profile.length).toBeGreaterThan(0);
  });
});
