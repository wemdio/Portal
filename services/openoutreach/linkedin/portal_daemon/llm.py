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

logger = logging.getLogger('li2.llm')

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
    Минимальная подстановка `{var}` в строку. Не использует jinja2 — наши
    промпты в li2_settings уже отрендерены человеком, нам только нужно
    подставить runtime-переменные (lead name, headline, etc.).
    Безопасно для пользовательских строк (нет execution).
    """
    out = template
    for k, v in kwargs.items():
        out = out.replace('{' + k + '}', str(v) if v is not None else '')
    return out
