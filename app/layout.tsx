import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider, themeInitScript } from "@/components/theme/ThemeProvider";

// 본문 기본 폰트(sans)는 globals.css 의 --font-sans = Pretendard(단일 소스)가 담당한다.
// 여기서는 코드/식별자용 monospace(font-mono)만 next/font 로 로드한다.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Vraxium Admin",
  description: "Vraxium admin portal",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {/* 하이드레이션 전에 저장된 테마를 html.dark 에 먼저 적용 → 다크 새로고침 시 흰 화면 깜빡임(FOUC) 제거.
            App Router 권장 방식(next/script beforeInteractive) — 수동 <head>/raw <script> 의 hydration 충돌 회피. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
