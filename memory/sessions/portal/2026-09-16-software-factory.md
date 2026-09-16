---
{
  "id": "2026-09-16-software-factory",
  "title": "Software Factory adapted to Portal branch and evidence boundaries",
  "domain": "portal",
  "kind": "session",
  "status": "verified",
  "scope": "codex/software-factory-20260916 based on engSPF 5c0f0ac07; repo skills and local tooling only",
  "actor": "codex/software-factory-20260916",
  "sources": [
    "docs/software-factory.md; docs/software-factory-upstream.json; scripts/software-factory-check.py; .artifacts/software-factory/report.md"
  ],
  "recorded_at": "2026-09-16",
  "created_at": "2026-09-16T05:34:43.818750+00:00",
  "checked_at": "2026-09-16",
  "review_after": "2026-10-16"
}
---

Запрос: внедрить Software Factory из michaelshimeles/skills в Portal.

В отдельном worktree от engSPF 5c0f0ac07 подготовлена ветка codex/software-factory-20260916. Семь навыков установлены с pinned upstream 513f8a24aae6383b00356fa285144b1bc3730dc1 в .agents/skills; .claude/skills использует относительные ссылки. Общий workflow добавлен в AGENTS.md, команды и ограничения описаны в docs/software-factory.md. Переход в другие ветки и deployment не выполнялись.

Важные адаптации: сохранять выбранную базу/рабочую копию вместо автоматического origin/main; завершать обычную задачу commit/push; Greptile только для запрошенного этапа существующего PR; evidence локально в ignored .artifacts; публичные upload-адаптеры не перенесены. В app/package.json predev/prestart вызывают DB migration helper, а dev запускает workers: их нельзя считать обычной подготовкой изолированной задачи. UI_ONLY отключает загрузку ../.env, но не очищает унаследованные переменные и не изолирует сеть.

Проверено: 7 навыков прошли quick_validate; 8 проверок структуры, ссылок, игнорирования и ошибок установки прошли; 5 unit-тестов upstream recorder прошли. Один выбранный upstream CLI-тест остановился на отсутствии FFmpeg/ffprobe, полный видеопроход не проверен. Live Greptile не запускался. Recorder сохранён побайтно, source SHA и checksums записаны в manifest.

Набор доступен в рабочей копии задачи. Другим веткам потребуется обычный перенос пользователем; не утверждать, что это уже внедрено в main/test или production. Исходные незакоммиченные изменения пользователя не включать в коммит Factory.
