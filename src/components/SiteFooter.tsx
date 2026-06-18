import Link from "next/link";
import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-ink-700/70 bg-ink-900/60">
      <div className="container-page grid gap-10 py-12 md:grid-cols-4">
        <div className="md:col-span-1">
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-slate-400">
            Распределённый мониторинг сайтов, API и инфраструктуры.
          </p>
        </div>

        <FooterCol
          title="Продукт"
          links={[
            { href: "/#features", label: "Возможности" },
            { href: "/pricing", label: "Тарифы" },
            { href: "/about", label: "Инфраструктура" },
            { href: "/register", label: "Начать мониторинг" },
          ]}
        />
        <FooterCol
          title="Правовая информация"
          links={[
            { href: "/terms", label: "Пользовательское соглашение" },
            { href: "/privacy", label: "Политика конфиденциальности" },
            { href: "/contacts", label: "Контакты" },
          ]}
        />
        <FooterCol
          title="Аккаунт"
          links={[
            { href: "/login", label: "Войти" },
            { href: "/register", label: "Создать аккаунт" },
            { href: "/dashboard", label: "Панель" },
          ]}
        />
      </div>
      <div className="border-t border-ink-700/70">
        <div className="container-page flex flex-col items-center justify-between gap-2 py-6 text-xs text-slate-500 sm:flex-row">
          <p>© {new Date().getFullYear()} Sentela. Все права защищены.</p>
          <p>Проверки выполняются с распределённых узлов мониторинга.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h4 className="mb-3 text-sm font-semibold text-white">{title}</h4>
      <ul className="space-y-2 text-sm text-slate-400">
        {links.map((l) => (
          <li key={l.href + l.label}>
            <Link href={l.href} className="hover:text-brand-300">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
