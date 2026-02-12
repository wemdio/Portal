import { useEffect, useState } from 'react';

type TelegramWebApp = {
  initData?: string;
};

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
};

const TMA_MOBILE_MEDIA_QUERY = '(max-width: 900px)';
const COARSE_POINTER_MEDIA_QUERY = '(pointer: coarse)';

function isLikelyMobileDevice() {
  if (typeof navigator === 'undefined') return false;

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

export function useIsTma() {
  const getIsTma = () => {
    if (typeof window === 'undefined') return false;
    const win = window as TelegramWindow;
    const hasWebApp = Boolean(win.Telegram?.WebApp);
    const hasInitData = Boolean(win.Telegram?.WebApp?.initData);
    const flagged = document.documentElement.dataset.tma === '1';
    const isTelegramUa = /Telegram/i.test(navigator.userAgent);
    const hasTmaContext = hasWebApp || hasInitData || flagged || isTelegramUa;
    const isMobileViewport = window.matchMedia(TMA_MOBILE_MEDIA_QUERY).matches;
    const hasCoarsePointer = window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches;
    const isMobileRuntime = isLikelyMobileDevice() || hasCoarsePointer;
    return hasTmaContext && isMobileRuntime && isMobileViewport;
  };
  const [isTma, setIsTma] = useState(getIsTma);

  useEffect(() => {
    const update = () => setIsTma(getIsTma());
    update();
    window.addEventListener('tma-ready', update);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('tma-ready', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return isTma;
}
