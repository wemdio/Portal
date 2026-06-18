"""
Пред-засев LinkedIn-сессии для li2-аккаунта (обход checkpoint первого входа).

Свежий аккаунт почти всегда упирается в /checkpoint на первом автологине, а
keep-alive паузы для VNC ещё нет. Обход: залогиниться ВРУЧНУЮ в headed-браузере
(решить капчу руками) ЧЕРЕЗ ТОТ ЖЕ residential-прокси, что использует демон, и
сохранить cookies в li2_browser_sessions. Демон стартует уже залогиненным с того
же IP → checkpoint первого входа не триггерится. Сессия лежит в Postgres →
переживает редеплои контейнера.

Запуск (локально, с реальным дисплеем; DATABASE_URL → прод-Supabase):

    python manage.py seed_li2_session --user-id <portal-user-uuid>

Прокси берётся из li2_settings юзера (или --proxy). Скрипт ждёт, пока ты
залогинишься (появится /feed/), затем пишет storage_state в БД.
"""
from __future__ import annotations

import asyncio

from django.core.management.base import BaseCommand, CommandError

from li2.models import Account, BrowserSession, PortalSettings
from linkedin.portal_daemon.browser_session import (
    DESKTOP_UA,
    DESKTOP_VIEWPORT,
    _STEALTH,
    parse_proxy_url,
)


class Command(BaseCommand):
    help = 'Засеять LinkedIn storage_state в li2_browser_sessions (ручной логин через прокси демона).'

    def add_arguments(self, parser):
        parser.add_argument('--user-id', required=True,
                            help='Portal user_id (uuid) — владелец li2-аккаунта')
        parser.add_argument('--proxy', default=None,
                            help='Переопределить proxy_url (иначе берётся из li2_settings юзера)')
        parser.add_argument('--timeout', type=int, default=600,
                            help='Сколько секунд ждать ручного логина (default 600)')

    def handle(self, *args, **opts):
        user_id = opts['user_id']

        # Upsert строки аккаунта: засев можно делать ДО первого старта кампании
        # (status='stopped' — демон её не трогает, пока кампания не запущена).
        # /start позже сделает upsert по user_id и переведёт в 'running'.
        account, created = Account.objects.get_or_create(
            user_id=user_id,
            defaults={'status': 'stopped', 'runtime_status': 'idle'},
        )
        if created:
            self.stdout.write(self.style.NOTICE(
                f'Создал строку li2_accounts для user_id={user_id} (status=stopped).'
            ))

        s = PortalSettings.objects.filter(user_id=user_id).first()
        raw_proxy = opts['proxy']
        if raw_proxy is None:
            raw_proxy = (s.proxy_url if s else '') or ''
        try:
            proxy = parse_proxy_url(raw_proxy)
        except Exception as e:
            raise CommandError(f'Битый proxy_url: {e}')

        li_email = (s.linkedin_email if s else '') or ''
        li_password = (s.linkedin_password if s else '') or ''

        if proxy is None:
            self.stderr.write(self.style.WARNING(
                'ВНИМАНИЕ: прокси не задан. Сессия будет создана с твоего реального IP. '
                'Если демон ходит через прокси, LinkedIn заметит смену IP и кинет checkpoint. '
                'Лучше прерви (Ctrl+C) и задай residential-прокси (http://user:pass@host:port).'
            ))

        where = f'через прокси {proxy["server"]}' if proxy else 'БЕЗ прокси'
        how = ('Подставляю логин/пароль автоматически — реши капчу/2FA, если будет. '
               if (li_email and li_password) else 'Залогинься вручную. ')
        self.stdout.write(self.style.NOTICE(
            f'Открываю headed Chromium {where}. {how}Жду появления /feed/…'
        ))

        try:
            state = asyncio.run(self._capture(proxy, opts['timeout'], li_email, li_password))
        except TimeoutError:
            raise CommandError('Не дождался логина (timeout). Увеличь --timeout и попробуй снова.')

        BrowserSession.objects.update_or_create(
            account_id=account.id,
            defaults={'user_id': account.user_id, 'storage_state': state, 'cookies': b''},
        )
        n_cookies = len(state.get('cookies', []))
        self.stdout.write(self.style.SUCCESS(
            f'✓ Сессия записана в li2_browser_sessions (account_id={account.id}, '
            f'{n_cookies} cookies). Демон подхватит её на ближайшем поллинге.'
        ))

    async def _capture(self, proxy: dict | None, timeout: int,
                       email: str = '', password: str = '') -> dict:
        from playwright.async_api import async_playwright

        launch_kwargs: dict = {
            'headless': False,
            'args': ['--no-sandbox', '--disable-blink-features=AutomationControlled',
                     '--disable-dev-shm-usage'],
        }
        if proxy:
            launch_kwargs['proxy'] = proxy

        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_kwargs)
            ctx = await browser.new_context(viewport=DESKTOP_VIEWPORT, user_agent=DESKTOP_UA)
            await _STEALTH.apply_stealth_async(ctx)
            page = await ctx.new_page()
            await page.goto('https://www.linkedin.com/login', wait_until='domcontentloaded')

            # Авто-подставляем креды (оператору остаётся капча/2FA, если будет).
            # LinkedIn /login: поля type=email/password с React-id'шками, причём
            # их по две (видимая форма + скрытый дубль) — целимся в ВИДИМУЮ.
            if email and password:
                try:
                    await page.wait_for_timeout(4000)  # дать /login догрузиться через прокси
                    email_loc = page.locator('input[type="email"]:visible').first
                    pass_loc = page.locator('input[type="password"]:visible').first
                    await email_loc.wait_for(state='visible', timeout=25000)
                    await email_loc.fill(email)
                    await pass_loc.fill(password)
                    # Enter в поле пароля надёжнее клика по кнопке (id/структура
                    # кнопки «Sign in» нестабильна между вариантами LinkedIn-UI).
                    await pass_loc.press('Enter')
                    await page.wait_for_timeout(3000)
                    self.stdout.write('autofill OK: видимые email/password → Enter')
                except Exception as e:
                    self.stdout.write(f'autofill error: {str(e)[:200]} — введи руками в VNC')

            waited = 0
            while waited < timeout:
                url = page.url
                if '/feed' in url or '/mynetwork' in url:
                    break
                await asyncio.sleep(2)
                waited += 2
            else:
                await browser.close()
                raise TimeoutError()

            await asyncio.sleep(2)  # дать cookies устаканиться
            state = await ctx.storage_state()
            await browser.close()
            return state
