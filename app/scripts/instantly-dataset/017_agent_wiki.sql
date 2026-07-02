-- 017_agent_wiki.sql — вики специалиста ЖИВЁТ В БД, не в раздаваемой папке.
-- Контент (плейбук, метрики, метод разбора клиента, источники, правила подсчёта лидов) —
-- строками agent_wiki; грузится из app/scripts/instantly-dataset/wiki/*.md скриптом
-- load-agent-wiki.mjs. Claude специалиста читает их живьём по MCP → обновление = правка .md
-- + перезапуск загрузчика; раздаваемую папку (только .mcp.json + тонкий CLAUDE.md) не трогаем.
CREATE TABLE IF NOT EXISTS agent_wiki (
  slug        text PRIMARY KEY,
  title       text NOT NULL,
  body        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE agent_wiki IS 'Вики read-only специалиста (плейбук, метрики, метод разбора, источники, правила подсчёта лидов). Читать: SELECT slug,title FROM agent_wiki ORDER BY slug; затем SELECT body FROM agent_wiki WHERE slug=$1. Перед подсчётом лидов обязателен slug=lead-counting.';
-- read-only роль специалистов видит таблицу:
GRANT SELECT ON agent_wiki TO dataset_ro;
