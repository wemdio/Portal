import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_API_ID = int(os.environ["TELEGRAM_API_ID"])
TELEGRAM_API_HASH = os.environ["TELEGRAM_API_HASH"]
TELEGRAM_PHONE = os.environ.get("TELEGRAM_PHONE")

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SESSION_PATH = str(DATA_DIR / os.environ.get("SESSION_NAME", "test_reviewer"))
DB_PATH = DATA_DIR / "reviewer.db"

LLM_API_KEY = os.environ["LLM_API_KEY"]
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://router.requesty.ai/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "anthropic/claude-sonnet-4-20250514")

REPORT_CHAT_ID = int(os.environ["REPORT_CHAT_ID"])
REPORT_TOPIC_ID = int(os.environ["REPORT_TOPIC_ID"])

PERSONAL_FOLDER_NAME = os.environ.get("PERSONAL_FOLDER_NAME", "Personal")


def load_tasks() -> list[dict]:
    tasks_file = Path(__file__).parent / "tasks.json"
    with open(tasks_file, "r", encoding="utf-8") as f:
        return json.load(f)["tasks"]


TASKS = load_tasks()
KEYWORDS: dict[str, dict] = {task["keyword"].lower(): task for task in TASKS}
