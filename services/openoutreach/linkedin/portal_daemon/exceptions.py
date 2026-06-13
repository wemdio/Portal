"""
Daemon-specific exceptions, обрабатываемые AccountWorker'ом и main loop'ом.

Соглашение: daemon ловит только expected, recoverable ошибки (CAPTCHA, auth-
fail). Всё остальное пробрасывается выше и тушит соответствующий
AccountWorker (без выкидывания всего процесса), оставляя запись в PortalLog.
"""


class CaptchaDetected(Exception):
    """
    LinkedIn вывел /checkpoint/ — нужно вмешательство оператора через VNC.
    Daemon флипает li2_accounts.status='needs_captcha' и сворачивает Worker.
    """


class AuthenticationError(Exception):
    """
    LinkedIn 401 / redirect на /login / banned. Cookies устарели, нужен
    re-login или человек. Daemon флипает status='disconnected'.
    """


class WorkingHoursViolation(Exception):
    """
    Task try'нул выполниться за пределами campaign.working_hours. Это
    программная ошибка планировщика (он должен был перенести scheduled_at),
    но executor поднимает её на всякий случай чтобы не уйти в неконтролируемый
    burst в нерабочее время.
    """


class NoSettingsError(Exception):
    """
    У PortalSettings нет linkedin_email/password — невозможно даже логиниться.
    Не флипаем 'disconnected' (нечем переподключаться); просто пишем error в
    PortalLog и спим.
    """


class ProxyConfigError(Exception):
    """
    proxy_url в li2_settings задан, но не парсится в валидный Playwright
    proxy (битый формат, либо socks5+auth, который Chromium не поддерживает).

    Запускать браузер БЕЗ прокси в этом случае нельзя — LinkedIn-трафик уйдёт
    с реального/датацентрового IP → бан. Daemon флипает status='disconnected'
    с actionable-сообщением; оператор чинит proxy_url в UI и переподключает.
    """
