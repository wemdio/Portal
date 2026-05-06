import json
import logging
from openai import AsyncOpenAI
import config

logger = logging.getLogger(__name__)

llm = AsyncOpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_BASE_URL)

SYSTEM_PROMPT = """\
Ты — эксперт по оценке тестовых заданий кандидатов на вакансию.
Твоя задача — объективно оценить выполненное тестовое задание по заданным критериям.

Правила:
- Будь строг, но справедлив.
- Если работа явно полностью сгенерирована ИИ без авторской переработки — ставь 0-1 по самостоятельности.
- Если видна авторская работа с ИИ как инструментом — это допустимо.
- Давай конкретные, полезные комментарии к каждому критерию.
- Оценивай по существу, а не по объёму.

Отвечай СТРОГО в формате JSON без markdown-обёрток (без ```json)."""


def _build_user_prompt(doc_content: str, task: dict) -> str:
    criteria_lines = "\n".join(
        f"  {i + 1}. {c['name']} (0–{c['max_score']}): {c.get('description', '')}"
        for i, c in enumerate(task["criteria"])
    )
    return f"""\
Позиция: {task["keyword"]}

Описание тестового задания:
{task.get("description", "Описание не предоставлено.")}

Критерии оценки:
{criteria_lines}

Порог прохождения: {task["pass_threshold"]} из {task["max_total"]}

--- ДОКУМЕНТ КАНДИДАТА ---
{doc_content[:50000]}
--- КОНЕЦ ДОКУМЕНТА ---

Оцени задание по каждому критерию. Ответь в JSON:
{{
  "scores": [
    {{
      "criterion": "название критерия",
      "score": <число>,
      "max_score": <число>,
      "comment": "комментарий (1-2 предложения)"
    }}
  ],
  "total_score": <число>,
  "max_total": {task["max_total"]},
  "overall_comment": "общий комментарий (2-3 предложения)",
  "passed": true/false
}}"""


async def analyze_document(doc_content: str, task: dict) -> dict | None:
    """Send document to LLM for scoring. Returns parsed result or None on failure."""
    try:
        response = await llm.chat.completions.create(
            model=config.LLM_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_prompt(doc_content, task)},
            ],
            temperature=0.3,
            max_tokens=2000,
        )

        content = response.choices[0].message.content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()

        result = json.loads(content)

        total = sum(s["score"] for s in result["scores"])
        result["total_score"] = total
        result["passed"] = total >= task["pass_threshold"]

        return result

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse LLM response: {e}")
        return None
    except Exception as e:
        logger.error(f"LLM analysis error: {e}")
        return None
