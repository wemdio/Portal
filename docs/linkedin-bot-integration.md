# LinkedIn Bot — интеграция в Portal (TypeScript)

## Обзор

LinkedIn Bot интегрирован полностью на **TypeScript/JavaScript**:
- Библиотека `linkedin-private-api` (Node.js, без Python)
- API routes и UI в Next.js
- Импорт в «Работа с базами» + экспорт CSV/Excel

## Структура

```
app/src/
├── lib/linkedinBot/
│   ├── linkedin.ts     # Поиск компаний через linkedin-private-api
│   ├── urlParser.ts    # Парсинг URL поиска
├── app/api/tools/linkedin-bot/
│   ├── scrape/route.ts
└── app/tools/linkedin-bot/
    └── page.tsx
```

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `LINKEDIN_LOGIN` | Логин LinkedIn |
| `LINKEDIN_PASSWORD` | Пароль LinkedIn |

Лимит компаний настраивается в UI (по умолчанию 600).

## Примечание

Библиотека `linkedin-private-api` сохраняет сессию в `sessions.json` в корне проекта. LinkedIn может блокировать аккаунты при интенсивном использовании — используйте осторожно.
