import fs from 'fs';
import Papa from 'papaparse';
import { JSDOM } from 'jsdom';

const OPENROUTER_API_KEY = process.env.OPENROUTER_PERSONALIZATION_API_KEY || '';
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_PERSONALIZATION_API_KEY not set. Run with: OPENROUTER_PERSONALIZATION_API_KEY=your-key node personalize-emails.mjs');
  process.exit(1);
}
const MODEL = 'anthropic/claude-sonnet-4';
const TEST_LIMIT = 10;

const raw = fs.readFileSync('../сезонный бизнес - сезонный бизнес.csv', 'utf-8');
const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });

const valid = data.filter(r =>
  r.Company?.trim() &&
  r.Email?.includes('@') &&
  r.Site?.startsWith('http') &&
  r.Description?.trim().length > 20
);

console.log(`Valid companies: ${valid.length}. Taking first ${TEST_LIMIT} for test.\n`);

async function fetchSiteText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
    });
    const html = await resp.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    doc.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());

    const title = doc.querySelector('title')?.textContent?.trim() || '';
    const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const h1 = Array.from(doc.querySelectorAll('h1')).map(el => el.textContent.trim()).join(' | ');
    const h2 = Array.from(doc.querySelectorAll('h2')).map(el => el.textContent.trim()).slice(0, 6).join(' | ');
    const body = doc.body?.textContent?.replace(/\s+/g, ' ').trim().substring(0, 3000) || '';

    return { title, metaDesc, h1, h2, body: body.substring(0, 2000) };
  } catch (e) {
    return { title: '', metaDesc: '', h1: '', h2: '', body: `[Ошибка загрузки: ${e.message}]` };
  } finally {
    clearTimeout(timer);
  }
}

async function generateEmail(company, siteData, index) {
  const openingStyles = [
    'Начни с вопроса, который покажет понимание их ситуации.',
    'Начни с короткой истории или аналогии из их отрасли.',
    'Начни от первого лица — расскажи как ты натолкнулся на их компанию и что подумал.',
    'Начни с конкретной цифры или факта из их бизнеса, который привлёк внимание.',
    'Начни с провокационного утверждения о их рынке.',
    'Начни с комплимента чему-то конкретному, что они делают хорошо.',
    'Начни с проблемы, которую ты видишь в их нише.',
    'Начни с наблюдения об их конкурентах или рынке в целом.',
    'Начни максимально прямо — без прелюдии, сразу к делу.',
    'Начни с неожиданного угла — не про бизнес напрямую, а про что-то смежное.',
  ];

  const styleHint = openingStyles[index % openingStyles.length];

  const prompt = `Ты пишешь холодное письмо. Не как маркетолог, а как живой человек, который реально заинтересовался компанией и хочет предложить идею.

КТО ТЫ: Егор, руководитель отдела продаж в маркетинговом агентстве Polza. Вы помогаете компаниям получать новых клиентов через email-рассылки по базам ЛПР. За август привлекли 380+ лидов для 38 компаний. Гарантируете результат в договоре.

КОМПАНИЯ-ПОЛУЧАТЕЛЬ:
Название: ${company.Company}
Сайт: ${company.Site}
Описание: ${company.Description}
Title: ${siteData.title}
Meta: ${siteData.metaDesc}
Заголовки: ${siteData.h1} | ${siteData.h2}
Текст с сайта: ${siteData.body}

СУТЬ ПРЕДЛОЖЕНИЯ (НЕ копируй дословно, перескажи своими словами, естественно):
У этой компании сезонный бизнес. Сейчас межсезонье — спрос ниже. Идея: подготовить всё для привлечения клиентов сейчас (пока есть время), а запуститься ближе к сезону. Так к пику спроса уже будет поток клиентов, и не будет денежной просадки.

СТИЛЬ НАЧАЛА ПИСЬМА: ${styleHint}

ГЛАВНЫЕ ПРАВИЛА:

1. Пиши как человек, а не как маркетинговый робот. Представь: ты отправляешь письмо знакомому знакомого. Не клиенту, а человеку.

2. ЗАПРЕЩЕНО использовать эти шаблонные конструкции (и похожие на них):
   - "Заметил на вашем сайте..."
   - "Обратил внимание, что вы..."
   - "Мы в [компания] занимаемся..."
   - "Мы помогаем компаниям..."
   - "Предлагаю обсудить детали..."
   - "Интересно было бы обсудить?"
   - "Стабильный поток клиентов/лидов"
   - "Лица, принимающие решения" или "ЛПР"
   - "Персонализированные письма"
   - "Email outreach" / "лидогенерация" как термины
   - "Самое время подготовиться к сезону"
   - "Давайте созвонимся"
   - "Точечно привлекать"

3. Вместо продажных терминов — говори простым языком. Не "лидогенерация через email outreach", а опиши ЧТО КОНКРЕТНО вы делаете: собираете базу людей, которым нужны услуги компании, и пишете им от лица компании так, что это выглядит как личное сообщение. Но НЕ описывай это каждый раз одинаково.

4. Персонализация должна быть вплетена в текст, а не торчать отдельным абзацем "я посмотрел ваш сайт". Используй знания о компании чтобы ДУМАТЬ об их ситуации, а не просто перечислять факты с сайта.

5. Длина: 3-6 предложений. Короче = лучше. Каждое предложение должно нести смысл.

6. Конец: НЕ заканчивай шаблонным "давайте обсудим?". Закончи так, как закончил бы реальный человек: может вопросом о их бизнесе, может конкретным предложением следующего шага, может просто точкой.

7. Приветствие: "Здравствуйте!", "Добрый день!" или "Привет!" — выбери что подходит по тону.

ПОДПИСЬ (добавь после основного текста через пустую строку):
С уважением,
Егор
Руководитель отдела продаж
+7 (495) 120-29-71
https://polzaagency.ru
@ROP_PolzaAgency

Верни ТОЛЬКО текст письма. Без комментариев, пояснений, вариантов.`;

  const resp = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: 1000,
    }),
  });

  const json = await resp.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.choices?.[0]?.message?.content?.trim() || '[Ошибка генерации]';
}

async function main() {
  const testCompanies = valid.slice(0, TEST_LIMIT);
  const results = [];

  for (let i = 0; i < testCompanies.length; i++) {
    const company = testCompanies[i];
    console.log(`[${i + 1}/${TEST_LIMIT}] ${company.Company} — fetching ${company.Site}...`);

    const siteData = await fetchSiteText(company.Site);
    console.log(`  Site loaded: title="${siteData.title?.substring(0, 60)}"`);

    console.log(`  Generating email...`);
    const email = await generateEmail(company, siteData, i);

    results.push({
      Company: company.Company,
      Email: company.Email,
      Site: company.Site,
      Description: company.Description,
      'Персонализированное письмо': email,
    });

    console.log(`  ✓ Done\n`);
    console.log(`--- PREVIEW ---`);
    console.log(email.substring(0, 300));
    console.log(`--- END ---\n`);
  }

  const csvOut = Papa.unparse(results);
  const outPath = '../personalization-test-results.csv';
  fs.writeFileSync(outPath, '\uFEFF' + csvOut, 'utf-8');
  console.log(`\n✅ Results saved to ${outPath} (${results.length} rows)`);
}

main().catch(console.error);
