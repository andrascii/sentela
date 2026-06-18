import Link from "next/link";
import { Logo } from "./Logo";
import { getSessionUserId } from "@/lib/session";

export async function SiteHeader() {
  const uid = await getSessionUserId();
  const authed = uid != null;

  return (
    <header className="sticky top-0 z-40 border-b border-ink-700/70 bg-ink-900/80 backdrop-blur">
      <div className="container-page flex h-16 items-center justify-between">
        <Logo />
        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-300 md:flex">
          <Link href="/#features" className="hover:text-white">
            Возможности
          </Link>
          <Link href="/pricing" className="hover:text-white">
            Тарифы
          </Link>
          <Link href="/about" className="hover:text-white">
            О сервисе
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          {authed ? (
            <Link href="/dashboard" className="btn-primary">
              Панель
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost hidden sm:inline-flex">
                Войти
              </Link>
              <Link href="/register" className="btn-primary">
                Начать мониторинг
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
