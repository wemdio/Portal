"""
li2 — Portal-native Django app для интеграции OpenOutreach с Portal Supabase.

Модели в `models.py` имеют managed=False и таргетят `li2_*` таблицы, которые
владеются Portal'овской миграцией supabase/migrations/20260610_0001.

Daemon (`linkedin.daemon.main_loop`) работает только с этими моделями;
upstream'овские linkedin.Campaign/linkedin.Task оставлены для CLI-команд и
reference, но в проде не используются.
"""
default_app_config = 'li2.apps.Li2Config'
