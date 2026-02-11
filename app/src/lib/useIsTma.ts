import { useEffect, useState } from 'react';

type TelegramWebApp = {
  initData?: string;
};

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
};

export function useIsTma() {
  const getIsTma = () => {
    if (typeof window === 'undefined') return false;
    const win = window as TelegramWindow;
    const hasWebApp = Boolean(win.Telegram?.WebApp);
    const hasInitData = Boolean(win.Telegram?.WebApp?.initData);
    const flagged = document.documentElement.dataset.tma === '1';
    const isTelegramUa = /Telegram/i.test(navigator.userAgent);
    return hasWebApp || hasInitData || flagged || isTelegramUa;
  };
  const [isTma, setIsTma] = useState(getIsTma);

  useEffect(() => {
    const update = () => setIsTma(getIsTma());
    update();
    window.addEventListener('tma-ready', update);
    return () => {
      window.removeEventListener('tma-ready', update);
    };
  }, []);

  return isTma;
}
