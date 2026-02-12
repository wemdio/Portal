'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';

type TelegramWebApp = {
  initData: string;
  viewportHeight?: number;
  viewportStableHeight?: number;
  ready: () => void;
  expand: () => void;
  onEvent: (event: string, handler: () => void) => void;
  offEvent: (event: string, handler: () => void) => void;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

type VerifyResponse = {
  verified: boolean;
  link_token?: string;
  link_expires_at?: string;
  telegram_user?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    allows_write_to_pm?: boolean;
    photo_url?: string;
  };
  error?: string;
};

const STORAGE_KEYS = {
  token: 'tg_link_token',
  expiresAt: 'tg_link_expires_at',
  user: 'tg_user',
  isWebApp: 'tg_is_webapp',
} as const;
const TMA_THEME_STORAGE_KEY = 'tma_theme';
const TMA_MOBILE_MEDIA_QUERY = '(max-width: 900px)';
const COARSE_POINTER_MEDIA_QUERY = '(pointer: coarse)';

function storeLinkData(data: VerifyResponse) {
  if (!data.link_token || !data.link_expires_at) return;
  sessionStorage.setItem(STORAGE_KEYS.token, data.link_token);
  sessionStorage.setItem(STORAGE_KEYS.expiresAt, data.link_expires_at);
  if (data.telegram_user) {
    sessionStorage.setItem(STORAGE_KEYS.user, JSON.stringify(data.telegram_user));
  }
}

function clearLinkData() {
  sessionStorage.removeItem(STORAGE_KEYS.token);
  sessionStorage.removeItem(STORAGE_KEYS.expiresAt);
  sessionStorage.removeItem(STORAGE_KEYS.user);
}

function hasValidStoredToken() {
  const token = sessionStorage.getItem(STORAGE_KEYS.token);
  const expiresAt = sessionStorage.getItem(STORAGE_KEYS.expiresAt);
  if (!token || !expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
    clearLinkData();
    return false;
  }
  return true;
}

function applyViewport(webApp: TelegramWebApp) {
  const root = document.documentElement.style;
  if (webApp.viewportHeight) {
    root.setProperty('--app-viewport-height', `${webApp.viewportHeight}px`);
  }
  if (webApp.viewportStableHeight) {
    root.setProperty('--app-viewport-stable-height', `${webApp.viewportStableHeight}px`);
  }
}

function isTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

function isLikelyMobileDevice() {
  type NavigatorWithUserAgentData = Navigator & {
    userAgentData?: {
      mobile?: boolean;
    };
  };

  const nav = navigator as NavigatorWithUserAgentData;
  if (typeof nav.userAgentData?.mobile === 'boolean') {
    return nav.userAgentData.mobile;
  }

  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function applyTmaMode() {
  const root = document.documentElement;
  root.dataset.tma = '1';
  root.classList.add('tma');

  const isMobileViewport = window.matchMedia(TMA_MOBILE_MEDIA_QUERY).matches;
  const hasCoarsePointer = window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches;
  const isMobileRuntime = isLikelyMobileDevice() || hasCoarsePointer;
  if (!isMobileRuntime || !isMobileViewport) {
    root.classList.remove('tma-mobile');
    return;
  }

  root.classList.add('tma-mobile');
  const savedTheme = window.localStorage.getItem(TMA_THEME_STORAGE_KEY);
  const isSavedThemeValid = savedTheme === 'light' || savedTheme === 'dark';
  const currentTheme = root.dataset.tmaTheme;
  const isCurrentThemeValid = currentTheme === 'light' || currentTheme === 'dark';
  root.dataset.tmaTheme = isSavedThemeValid ? savedTheme : (isCurrentThemeValid ? currentTheme : 'dark');
}

export function TelegramWebAppProvider() {
  const [sdkReady, setSdkReady] = useState(() => {
    if (typeof window === 'undefined') return false;
    return Boolean(window.Telegram?.WebApp);
  });
  const initRef = useRef(false);

  useEffect(() => {
    if (!sdkReady || initRef.current) return;
    initRef.current = true;

    const webApp = isTelegramWebApp();
    if (!webApp) return;
    applyTmaMode();
    window.dispatchEvent(new Event('tma-ready'));

    const initData = webApp.initData;
    if (!initData) return;
    sessionStorage.setItem(STORAGE_KEYS.isWebApp, '1');

    webApp.ready();
    webApp.expand();
    applyViewport(webApp);

    const handleViewportChanged = () => {
      applyViewport(webApp);
      applyTmaMode();
      window.dispatchEvent(new Event('tma-ready'));
    };
    const handleWindowResize = () => {
      applyTmaMode();
      window.dispatchEvent(new Event('tma-ready'));
    };
    webApp.onEvent('viewportChanged', handleViewportChanged);
    window.addEventListener('resize', handleWindowResize);
    if (!hasValidStoredToken()) {
      void fetch('/api/telegram/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: initData }),
      })
        .then(async (res) => {
          if (!res.ok) {
            clearLinkData();
            return null;
          }
          return (await res.json()) as VerifyResponse;
        })
        .then((data) => {
          if (!data?.verified) {
            clearLinkData();
            return;
          }
          storeLinkData(data);
        })
        .catch(() => {
          clearLinkData();
        });
    }

    return () => {
      webApp.offEvent('viewportChanged', handleViewportChanged);
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [sdkReady]);

  return (
    <Script
      src="https://telegram.org/js/telegram-web-app.js"
      strategy="afterInteractive"
      onLoad={() => setSdkReady(true)}
    />
  );
}
