import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { LayoutShell } from "@/components/LayoutShell";
import { TelegramWebAppProvider } from "@/components/TelegramWebAppProvider";
import { LOCALE_COOKIE, normalizeLocale } from "@/lib/i18n";

const inter = Inter({ subsets: ["latin"] });
const earlyTmaThemeScript = `(function(){try{var root=document.documentElement;var ua=navigator.userAgent||"";var hasTelegramUa=/Telegram/i.test(ua);var hasWebApp=!!(window.Telegram&&window.Telegram.WebApp);var isTmaContext=hasTelegramUa||hasWebApp||root.dataset.tma==="1";if(!isTmaContext){return;}root.classList.add("tma");root.dataset.tma="1";var isMobileViewport=window.matchMedia("(max-width: 900px)").matches;if(!isMobileViewport){root.classList.remove("tma-mobile");return;}root.classList.add("tma-mobile");var saved=localStorage.getItem("tma_theme");var theme=(saved==="light"||saved==="dark")?saved:"dark";root.dataset.tmaTheme=theme;}catch(_err){}})();`;

export const metadata: Metadata = {
  title: "Portal",
  description: "Internal portal for project management",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const locale = normalizeLocale(cookieStore.get(LOCALE_COOKIE)?.value);

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: earlyTmaThemeScript,
          }}
        />
      </head>
      <body className={inter.className}>
        <TelegramWebAppProvider />
        <LayoutShell initialLocale={locale}>{children}</LayoutShell>
      </body>
    </html>
  );
}
