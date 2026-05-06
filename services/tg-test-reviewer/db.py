import sqlite3
import json
from config import DB_PATH


def _conn():
    return sqlite3.connect(str(DB_PATH))


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = _conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            chat_id INTEGER PRIMARY KEY,
            state TEXT DEFAULT 'IDLE',
            keyword TEXT,
            doc_url TEXT,
            username TEXT,
            first_name TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS processed (
            chat_id INTEGER,
            doc_url TEXT,
            scores TEXT,
            total_score INTEGER,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chat_id, doc_url)
        );
    """)
    conn.close()


def get_state(chat_id: int) -> dict:
    conn = _conn()
    row = conn.execute(
        "SELECT state, keyword, doc_url FROM conversations WHERE chat_id = ?",
        (chat_id,),
    ).fetchone()
    conn.close()
    if row:
        return {"state": row[0], "keyword": row[1], "doc_url": row[2]}
    return {"state": "IDLE", "keyword": None, "doc_url": None}


def set_state(
    chat_id: int,
    state: str,
    keyword: str | None = None,
    doc_url: str | None = None,
    username: str | None = None,
    first_name: str | None = None,
):
    conn = _conn()
    conn.execute(
        """
        INSERT INTO conversations (chat_id, state, keyword, doc_url, username, first_name, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(chat_id) DO UPDATE SET
            state = excluded.state,
            keyword = COALESCE(excluded.keyword, conversations.keyword),
            doc_url = COALESCE(excluded.doc_url, conversations.doc_url),
            username = COALESCE(excluded.username, conversations.username),
            first_name = COALESCE(excluded.first_name, conversations.first_name),
            updated_at = CURRENT_TIMESTAMP
        """,
        (chat_id, state, keyword, doc_url, username, first_name),
    )
    conn.commit()
    conn.close()


def is_doc_processed(chat_id: int, doc_url: str) -> bool:
    conn = _conn()
    row = conn.execute(
        "SELECT 1 FROM processed WHERE chat_id = ? AND doc_url = ?",
        (chat_id, doc_url),
    ).fetchone()
    conn.close()
    return row is not None


def save_result(chat_id: int, doc_url: str, scores: list, total_score: int):
    conn = _conn()
    conn.execute(
        """
        INSERT OR REPLACE INTO processed (chat_id, doc_url, scores, total_score, processed_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (chat_id, doc_url, json.dumps(scores, ensure_ascii=False), total_score),
    )
    conn.commit()
    conn.close()


def reset_stuck_states():
    """Reset PROCESSING states (stuck from crashes) and old WAITING_DOC states."""
    conn = _conn()
    conn.execute("UPDATE conversations SET state = 'IDLE' WHERE state = 'PROCESSING'")
    conn.execute(
        """
        UPDATE conversations SET state = 'IDLE'
        WHERE state = 'WAITING_DOC'
        AND updated_at < datetime('now', '-24 hours')
        """
    )
    conn.commit()
    conn.close()
