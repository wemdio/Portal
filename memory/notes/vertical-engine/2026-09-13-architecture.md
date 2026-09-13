---
{
  "id": "2026-09-13-architecture",
  "title": "Различать внутренний v2, ENG и версии в рабочих папках",
  "domain": "vertical-engine",
  "kind": "observation",
  "status": "verified",
  "scope": "Исходники локальных веток engSPF@4ce3aaee7 и ve2-redesign@7d8874583, проверены 2026-09-13; статус production не проверялся",
  "actor": "codex",
  "sources": [
    "user: AGENTS.md instructions в задаче 2026-09-13, раздел Vertical Engine v2 / ENG boundary",
    "git:4ce3aaee7:app/src/lib/hypothesisEngine/stages/index.ts",
    "git:4ce3aaee7:app/worker/hypothesisEngine.ts",
    "git:7d8874583:app/src/lib/verticalEngineV2/index.ts"
  ],
  "recorded_at": "2026-09-13",
  "checked_at": "2026-09-13",
  "review_after": "2026-10-13"
}
---

# Граница продуктов

По принятому пользователем решению существующие `hypothesisEngine`, `he_*`, `HE_MODEL_*` обслуживают ENG. Внутренний Vertical Engine v2 должен иметь отдельные `verticalEngineV2`, `ve_*`, worker/API и `VE_MODEL_*`. Не переносить бизнес-стадии между этими продуктами ради внутреннего редизайна.

Legacy-интерфейс скрывается только после готовности v2 и проверенного read-only архива внутренних запусков. Происхождение старого `he_projects` нельзя определять по `market`/`autopilot`: нужен проверенный реестр соответствий на стороне v2.

# Что действительно проверено

В `engSPF@4ce3aaee7` найден legacy-диспетчер со стадиями research/chain/base/template/dossier. В `ve2-redesign@7d8874583` обнаружены отдельные исходники `app/src/lib/verticalEngineV2`, включая `legacyArchive.ts`, `projects.ts`, `launchPortfolio.ts` и другие модули. Это проверка наличия исходников, не аудит реализации требований изоляции и не подтверждение деплоя.

На этом Mac рабочая папка v2 зарегистрирована в `codex-worktrees/vertical-engine-v2`; путь — навигационная подсказка на дату проверки. Перед новой задачей перепроверь `git worktree list` и текущий коммит. Не объявляй v2 отсутствующим по содержимому другого checkout.
