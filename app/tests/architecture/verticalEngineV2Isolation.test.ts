/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
// Единственный импорт приложения в этом файле: справочник ошибок кабинета —
// чистый модуль без зависимостей и чтения env, поэтому правило ниже остаётся
// таким же дешёвым, как проверки по исходникам рядом.
import {
  HE_CLIENT_ERROR_CODES,
  formatHeClientFailure,
  heClientFailureFor,
} from '@/lib/hypothesisEngine/clientErrors';

function tsFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function source(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Файлы-эндпоинты: в app router роут — только route.ts, остальное рядом — модули. */
function routeFiles(root: string): string[] {
  return tsFiles(root).filter((file) => path.basename(file) === 'route.ts');
}

/**
 * Код без комментариев — для правил, которые ищут конструкцию, а не слово.
 * Без этого правило срывается на докблоке, который САМ объясняет запрет
 * («`.select()` без аргументов вернул бы строку целиком»), и автор правки
 * учится не писать комментарий, а не не писать запрещённое.
 *
 * `//` с двоеточием перед ним не трогаем — это `https://`, а не комментарий.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Тело КАЖДОГО экспортированного хендлера отдельно: в трёх файлах ENG их по
 * два, и правило «токен есть где-то в файле» пропустило бы новый GET,
 * прикрытый скоупом соседнего POST.
 */
function httpHandlers(text: string): Array<{ method: string; body: string }> {
  const starts: Array<{ method: string; index: number }> = [];
  for (const match of text.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)) {
    starts.push({ method: match[1], index: match.index ?? 0 });
  }
  return starts.map((start, i) => ({
    method: start.method,
    body: text.slice(start.index, i + 1 < starts.length ? starts[i + 1].index : text.length),
  }));
}

/**
 * Механизмы скоупа владельца, применяемые в `/api/client/eng` (их четыре, а не
 * один: лоадеры apiGuards, опция scopeCreatedBy у деталки, фильтр по created_by
 * и фильтр по client_user_id в instantly-БД). Завёл новый механизм — допиши
 * сюда осознанно: список существует, чтобы «скоупа нет» нельзя было проскочить
 * молча. Все роуты ходят под service_role, RLS обойдён — приложение тут
 * единственный барьер.
 */
const ENG_SCOPE_TOKENS = [
  'loadClientHeProject',
  'loadClientHeVertical',
  'loadClientHeHypothesis',
  'loadClientHeBase',
  'loadClientHeChain',
  'loadClientHeTemplate',
  'scopeCreatedBy',
  'created_by',
  'client_user_id',
];

describe('Vertical Engine v2 architecture boundary', () => {
  const v2Lib = path.resolve(process.cwd(), 'src/lib/verticalEngineV2');
  const v2Api = path.resolve(process.cwd(), 'src/app/api/tools/vertical-engine-v2');
  const v2Components = path.resolve(process.cwd(), 'src/components/vertical-engine-v2');
  const v2Worker = path.resolve(process.cwd(), 'worker/verticalEngineV2.ts');

  it('has a dedicated v2 source tree and API namespace', () => {
    expect(fs.existsSync(v2Lib)).toBe(true);
    expect(fs.existsSync(v2Api)).toBe(true);
  });

  it('never imports ENG-owned Hypothesis Engine business modules', () => {
    const files = [
      ...tsFiles(v2Lib),
      ...tsFiles(v2Api),
      ...tsFiles(v2Components),
      ...(fs.existsSync(v2Worker) ? [v2Worker] : []),
    ];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect({ file, text: source(file) }).not.toEqual(
        expect.objectContaining({
          text: expect.stringMatching(
            /(?:from\s+|import\s*\()\s*['"][^'"]*hypothesisEngine(?:\/[^'"]*)?['"]/,
          ),
        }),
      );
    }
  });

  it('never writes to an he_* table from v2 code', () => {
    const files = [...tsFiles(v2Lib), ...tsFiles(v2Api)];
    const heMutation =
      /\.from\(\s*['"]he_[^'"]+['"]\s*\)(?:.|\n){0,300}\.(?:insert|upsert|update|delete)\s*\(/;

    for (const file of files) {
      expect({ file, text: source(file) }).not.toEqual(
        expect.objectContaining({ text: expect.stringMatching(heMutation) }),
      );
    }
  });

  it('keeps ENG and the existing Hypothesis Engine independent from v2', () => {
    const engOwnedFiles = [
      ...tsFiles(path.resolve(process.cwd(), 'src/lib/hypothesisEngine')),
      ...tsFiles(path.resolve(process.cwd(), 'src/app/api/client/eng')),
      path.resolve(process.cwd(), 'worker/hypothesisEngine.ts'),
    ].filter((file) => fs.existsSync(file));

    for (const file of engOwnedFiles) {
      expect({ file, text: source(file) }).not.toEqual(
        expect.objectContaining({
          text: expect.stringMatching(
            /(?:from\s+|import\s*\()\s*['"][^'"]*verticalEngineV2(?:\/[^'"]*)?['"]/,
          ),
        }),
      );
    }
  });

  it('runs an isolated worker without ENG autopilot or HE models', () => {
    expect(fs.existsSync(v2Worker)).toBe(true);
    const worker = source(v2Worker);
    const llm = source(path.join(v2Lib, 'llm.ts'));

    expect(worker).toMatch(/from\('ve_jobs'\)/);
    expect(worker).not.toMatch(/from\('he_jobs'\)/);
    expect(worker).not.toMatch(/autopilotNext|enqueueAutopilotFollowups|enqueueHeAutopilot/);
    expect(llm).toMatch(/VE_MODEL_RESEARCH/);
    expect(llm).not.toMatch(/HE_MODEL_RESEARCH/);
  });

  it('exposes v2 in the registry while the legacy internal route stays mounted', () => {
    const registry = source(path.resolve(process.cwd(), 'src/lib/toolsRegistry.ts'));
    const legacyPage = source(
      path.resolve(process.cwd(), 'src/app/tools/hypothesis-engine/page.tsx'),
    );
    const v2Page = path.resolve(
      process.cwd(),
      'src/app/tools/vertical-engine-v2/page.tsx',
    );

    // Cutover: v2 видим в реестре; легаси-роут остаётся (read-only баннер).
    expect(registry).toContain("'vertical-engine-v2'");
    expect(legacyPage).toContain('HypothesisEngineView');
    expect(fs.existsSync(v2Page)).toBe(true);
  });

  // Доступ в ENG-кабинете: правило форвардное — регрессии в прошлом не было,
  // но 27 пунктов плана портирования трогают эти роуты и часть добавляет новые
  // хендлеры в существующие файлы.
  it('authenticates, market-gates and owner-scopes every /api/client/eng handler', () => {
    const files = routeFiles(path.resolve(process.cwd(), 'src/app/api/client/eng'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const handlers = httpHandlers(source(file));
      expect({ file, count: handlers.length }).not.toEqual(
        expect.objectContaining({ count: 0 }),
      );

      for (const handler of handlers) {
        const where = `${path.relative(process.cwd(), file)} ${handler.method}`;
        expect({ where, authed: handler.body.includes('requireClientAuth') }).toEqual({
          where,
          authed: true,
        });
        // Рыночный гейт: ru-клиенту в ENG-контуре делать нечего, а middleware
        // гейтит только страницы (/api/... под его условие не попадает).
        expect({ where, gated: handler.body.includes('requireEngMarket') }).toEqual({
          where,
          gated: true,
        });
        expect({
          where,
          scoped: ENG_SCOPE_TOKENS.some((token) => handler.body.includes(token)),
        }).toEqual({ where, scoped: true });
      }
    }
  });

  // Цена трассировки — синхронные INSERT+UPDATE в trace_spans вокруг запроса,
  // а мастер и дашборд поллят свои GET'ы каждые 4 и 15 секунд. Поэтому
  // withToolTrace — только на мутирующих хендлерах кабинета.
  it('traces mutating /api/client/eng handlers only', () => {
    const files = routeFiles(path.resolve(process.cwd(), 'src/app/api/client/eng'));

    for (const file of files) {
      for (const handler of httpHandlers(source(file))) {
        const where = `${path.relative(process.cwd(), file)} ${handler.method}`;
        expect({ where, traced: handler.body.includes('withToolTrace') }).toEqual({
          where,
          traced: handler.method !== 'GET',
        });
      }
    }
  });

  // Правило по всему справочнику, а не по одному тексту: коды перебираются из
  // HE_CLIENT_ERROR_CODES, поэтому код, заведённый через месяц, проверяется сам
  // — как «у каждой новой таблицы есть grant» в tests/migrations/grants.test.ts.
  // Справочник — единственный источник текстов ошибок ENG-кабинета, и каждый из
  // них клиент видит на экране. Отсюда три запрета: кириллица (кабинет
  // английский, а стадии V1 пишут ошибки по-русски), имена провайдеров (бренд
  // рассыльщика и LLM клиенту не показываем) и имена наших таблиц he_*.
  it('keeps every ENG client-facing error text English and free of vendor and table names', () => {
    expect(HE_CLIENT_ERROR_CODES.length).toBeGreaterThan(0);

    for (const code of HE_CLIENT_ERROR_CODES) {
      const text = formatHeClientFailure(heClientFailureFor(code));
      expect({ code, cyrillic: /[А-Яа-яЁё]/.test(text) }).toEqual({ code, cyrillic: false });
      expect({
        code,
        internals: /Requesty|Serper|OpenRouter|Instantly|OpenAI|Postgres|he_[a-z_]+/i.test(text),
      }).toEqual({ code, internals: false });
    }
  });

  /**
   * Волна 0 три раунда закрывала утечки по одной, и каждый раз находилась
   * следующая: механизм у всех один — хендлер читает строку `he_*` без списка
   * колонок и отдаёт её клиенту. Так уехали `tokens_used`/`cost_usd` из
   * he_jobs (четыре роута) и `evidence` из he_hypotheses.
   *
   * Grep'ом волны это не ловилось принципиально: при `.select()` без
   * аргументов имён колонок в исходнике нет вообще. Зато сам `.select()` в
   * исходнике есть — на него правило и смотрит.
   *
   * Правило форвардное: оно не описывает сегодняшний код, а запрещает
   * конструкцию. Новая колонка в he_* (следующий `llm_model`, `cost_usd`,
   * внутренний id) при `.select()` уезжает клиенту молча, без единой правки
   * роута, — именно это и надо поймать. Запрет только на клиентском контуре:
   * staff-роуты и легаси /tools/hypothesis-engine читают `*` законно.
   */
  it('never reads an unbounded row in a /api/client/eng handler', () => {
    const files = routeFiles(path.resolve(process.cwd(), 'src/app/api/client/eng'));
    expect(files.length).toBeGreaterThan(0);

    // .select() и .select('*') / .select("*"), с любыми пробелами внутри.
    const unboundedSelect = /\.select\(\s*(?:['"]\s*\*\s*['"]\s*)?\)/;

    for (const file of files) {
      for (const handler of httpHandlers(withoutComments(source(file)))) {
        const where = `${path.relative(process.cwd(), file)} ${handler.method}`;
        expect({ where, unbounded: unboundedSelect.test(handler.body) }).toEqual({
          where,
          unbounded: false,
        });
      }
    }
  });

  /**
   * Планка волны 0 — «не на экране И не в payload». Экран закрывается дёшево:
   * компонент зовёт классификатор сам. Именно так выглядела первая версия —
   * тексты не печатались, но `he_projects.error` / `he_bases.error` уезжали в
   * тело ответа ЦЕЛИКОМ: русская проза стадии с именами наших таблиц, кодами
   * каталогов студии и uuid внутренних джоб, видимая в devtools.
   *
   * Правило форвардное и смотрит на КОНСТРУКЦИЮ, а не на сегодняшний текст.
   * Проектор — единственное место, где решается состав ответа кабинета, и
   * вернуть колонку в него можно ровно двумя способами: дописать `'error'` в
   * любой из белых списков (их девять, и следующий появится вместе со следующей
   * сущностью) либо присвоить сырьё в выходную строку мимо списков. Ловим оба.
   * Машинный код причины (`error_code`) под запрет не попадает — он и есть
   * замена: словарь закрытый, текста стадии в нём нет.
   */
  it('never ships a raw he_* stage error text to the ENG cabinet', () => {
    const projection = withoutComments(
      source(path.resolve(process.cwd(), 'src/lib/hypothesisEngine/clientEngProjection.ts')),
    );

    const whitelists = [...projection.matchAll(/const\s+(\w+)\s*=\s*\[([\s\S]*?)\]\s*as const;/g)];
    expect(whitelists.length).toBeGreaterThan(0);

    for (const [, name, body] of whitelists) {
      expect({ list: name, passesRawError: /(['"])error\1/.test(body) }).toEqual({
        list: name,
        passesRawError: false,
      });
    }

    // Мимо списков: `out.error = base.error`. `error_code` сюда не подходит —
    // после `error` идёт `_`, а не пробел и не знак присваивания.
    expect(/\.error\s*=(?!=)/.test(projection)).toBe(false);
  });

  it('bundles and deploys the v2 worker like every other dedicated worker', () => {
    const repoRoot = path.resolve(process.cwd(), '..');
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.worker'), 'utf8');
    const packageJson = fs.readFileSync(path.join(repoRoot, 'app/package.json'), 'utf8');
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    const deployTargets = fs.readFileSync(
      path.join(repoRoot, '.semaphore/select-deploy-targets.sh'),
      'utf8',
    );

    expect(dockerfile).toContain('worker/verticalEngineV2.ts');
    expect(packageJson).toContain('worker/verticalEngineV2.ts');
    expect(compose).toContain('worker-vertical-engine-v2:');
    expect(compose).toContain('WORKER_KIND=vertical-engine-v2');
    expect(deployTargets).toContain('worker-vertical-engine-v2');
  });
});
