"""
Тонкий HTTP-клиент к OpenRouter (через Requesty router) для LLM-вызовов.

Не зависит от pydantic-ai / OpenAI SDK — простой httpx.AsyncClient. Все
вызовы используют один общий API-key (`OPENROUTER_LI_OUTREACH_API_KEY`),
прочитанный из env при импорте.

См. Portal'овский /start route: api_base='https://router.requesty.ai/v1',
model='openai/gpt-4o-mini' (по умолчанию).
"""
from __future__ import annotations

import asyncio
import logging
import os

import httpx
from jinja2.sandbox import SandboxedEnvironment

logger = logging.getLogger('li2.llm')

# Промпты в li2_settings — Jinja2-шаблоны ({{ var }} / {% if %}), их формат
# задан и валидируется на Portal-стороне (app/src/lib/liOutreach/
# v2DefaultPrompts.ts + promptVarValidation.ts). Sandboxed-окружение блокирует
# доступ к небезопасным атрибутам, даже если оператор вставит вредный шаблон.
_JINJA_ENV = SandboxedEnvironment(
    autoescape=False,
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)

API_KEY = (os.environ.get('OPENROUTER_LI_OUTREACH_API_KEY') or '').strip()
API_BASE = os.environ.get('LI2_LLM_API_BASE', 'https://router.requesty.ai/v1').rstrip('/')
DEFAULT_MODEL = os.environ.get('LI2_LLM_MODEL', 'openai/gpt-4o-mini')

DEFAULT_TIMEOUT_SEC = 60.0
MAX_RETRIES = 2


class LLMError(Exception):
    """LLM API вернул ошибку или таймаут."""


async def complete(
    *,
    system: str,
    user: str,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 800,
    temperature: float = 0.6,
) -> str:
    """
    Один OpenAI-compatible chat-completion. Возвращает текст ответа.
    Бросает LLMError при неудаче (после MAX_RETRIES попыток).
    """
    if not API_KEY:
        raise LLMError('OPENROUTER_LI_OUTREACH_API_KEY is not set in env')

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'max_tokens': max_tokens,
        'temperature': temperature,
    }
    headers = {
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json',
    }

    last_error: Exception | None = None
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC) as client:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = await client.post(
                    f'{API_BASE}/chat/completions',
                    json=payload,
                    headers=headers,
                )
                if resp.status_code != 200:
                    body_preview = resp.text[:500] if resp.text else ''
                    raise LLMError(f'LLM API status={resp.status_code}: {body_preview}')
                data = resp.json()
                choices = data.get('choices') or []
                if not choices:
                    raise LLMError(f'LLM API returned no choices: {data}')
                content = (choices[0].get('message') or {}).get('content', '')
                if not content:
                    raise LLMError('LLM API returned empty content')
                return content.strip()
            except (httpx.RequestError, LLMError) as e:
                last_error = e
                logger.warning('LLM call failed (attempt %d/%d): %s', attempt, MAX_RETRIES, e)
                if attempt < MAX_RETRIES:
                    await asyncio.sleep(2 * attempt)
    raise LLMError(f'LLM call failed after {MAX_RETRIES} retries: {last_error}')


def render_prompt(template: str, **kwargs) -> str:
    """
    Рендерим Jinja2-шаблон промпта runtime-переменными (lead name, product,
    objective, ...). Отсутствующие переменные → пустая строка (Jinja2 Undefined),
    а НЕ литеральный `{{ var }}` — критично, чтобы в сообщение леду никогда не
    утёк сырой плейсхолдер.

    На сломанном шаблоне (синтаксис Jinja) не валимся — логируем и возвращаем
    исходный текст с грубой подстановкой, чтобы не уронить весь follow-up task.
    """
    try:
        return _JINJA_ENV.from_string(template).render(**kwargs).strip()
    except Exception:
        logger.exception('render_prompt: Jinja2 render failed, falling back to naive substitution')
        out = template
        for k, v in kwargs.items():
            val = str(v) if v is not None else ''
            out = out.replace('{{ ' + k + ' }}', val).replace('{' + k + '}', val)
        return out.strip()
