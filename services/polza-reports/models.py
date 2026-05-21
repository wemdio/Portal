"""Data structures shared between scraper, trigga, and formatter.

These are the same dataclasses that lived in scraper.py and app_settings.py of
the original polza_bot — extracted here so scraper/trigga/formatter can all
import them without importing each other in a circular way (and so the service
doesn't pull in SQLite / Telegram-specific code).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class ColdyCredentials:
    email: str
    password: str
    url: str

    @property
    def is_complete(self) -> bool:
        return bool(self.email and self.password)


@dataclass
class LetterStat:
    name: str
    sent: int
    opened: int
    opened_pct: float
    replied: int
    replied_pct: float
    is_variant: bool = False


@dataclass
class CampaignAnalytics:
    connected: int
    opened: int
    opened_pct: float
    replied: int
    replied_pct: float
    interested: int
    interested_pct: float
    letters: list[LetterStat] = field(default_factory=list)


@dataclass
class Campaign:
    name: str
    status: str
    created: str
    sent: int
    connected_reached: int   # X from X/Y
    connected_total: int     # Y from X/Y
    opened: int
    opened_pct: float
    replied: int
    replied_pct: float
    url: str = ""
    row_index: int = 0
    analytics: Optional[CampaignAnalytics] = None
