import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { LayoutShell } from "@/components/LayoutShell";
import { TelegramWebAppProvider } from "@/components/TelegramWebAppProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {

  description: "Internal portal for project management",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <TelegramWebAppProvider />
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
