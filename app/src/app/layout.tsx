import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { LayoutShell } from "@/components/LayoutShell";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {

  description: "Internal portal for project management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
