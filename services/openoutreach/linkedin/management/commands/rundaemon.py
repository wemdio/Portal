"""
Portal-native rundaemon: запускает multi-tenant async main loop.

Заменяет upstream single-tenant flow (onboarding wizard → SiteConfig.load →
single browser session). Никакого interactive onboarding нет — credentials
прилетают per-user из li2_settings, daemon стартует независимо от того, есть
ли хоть один активный аккаунт (просто будет сидеть в poll loop пока кто-то
не нажмёт «Старт» в UI).

migrate перед запуском — для upstream'овских apps (auth, contenttypes, sites,
linkedin, crm, chat). На li2_*-таблицы НЕ влияет (managed=False, схема
держится Portal'овской миграцией). На пустой БД (тесты, dev) — создаёт всё
нужное; в проде — no-op (всё уже мигрировано).
"""
from __future__ import annotations

import logging

from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Run the Portal-native OpenOutreach daemon (multi-tenant async main loop).'

    def add_arguments(self, parser):
        parser.add_argument(
            '--skip-migrate',
            action='store_true',
            help='Skip the migrate step (useful for tests or in containers, где migrate уже прошёл).',
        )

    def handle(self, *args, **options):
        self._configure_logging(verbose=options['verbosity'] >= 2)

        if not options['skip_migrate']:
            try:
                call_command('migrate', '--no-input')
            except Exception as e:
                # Если migrate упал из-за уже существующих таблиц или
                # отсутствия миграций — это окей для li2_*-only режима.
                # Логируем, продолжаем.
                self.stderr.write(self.style.WARNING(
                    f'migrate skipped/failed: {e}. Continuing (this is OK if только li2_* нужен).',
                ))

        from linkedin.portal_daemon.main_loop import run_forever
        run_forever()

    def _configure_logging(self, verbose: bool = False) -> None:
        # Используем upstream'овский configure_logging если есть, иначе basic.
        try:
            from linkedin.logging import configure_logging, print_banner
            level = logging.DEBUG if verbose else logging.INFO
            configure_logging(level=level)
            try:
                print_banner()
            except Exception:
                pass
        except ImportError:
            logging.basicConfig(
                level=logging.DEBUG if verbose else logging.INFO,
                format='%(asctime)s %(levelname)s %(name)s: %(message)s',
            )
