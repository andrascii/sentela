import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sentela — Распределённый мониторинг сайтов, API и инфраструктуры",
    template: "%s — Sentela",
  },
  description:
    "Мониторинг доступности, задержек, SSL, DNS и здоровья API из разных регионов. Мгновенные оповещения в Telegram, когда что-то ломается.",
  metadataBase: new URL(process.env.APP_BASE_URL || "http://localhost:3000"),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
