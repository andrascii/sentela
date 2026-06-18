import Link from "next/link";

const FEATURES = [
  {
    title: "Мониторинг доступности",
    desc: "Непрерывные проверки доступности сайтов и сервисов со статусами «доступен / недоступен / деградация».",
    icon: "M3 12h4l3-7 4 14 3-7h4",
  },
  {
    title: "Проверки API",
    desc: "Проверяйте REST и HTTP эндпоинты — коды ответов, задержку и доступность по расписанию.",
    icon: "M4 7h16M4 12h16M4 17h10",
  },
  {
    title: "Мониторинг SSL-сертификатов",
    desc: "Отслеживайте срок действия сертификатов и получайте предупреждения до их истечения.",
    icon: "M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z",
  },
  {
    title: "DNS-проверки",
    desc: "Резолвите имена хостов и заранее обнаруживайте сбои или ошибки конфигурации DNS.",
    icon: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  },
  {
    title: "Оповещения в Telegram",
    desc: "Мгновенные уведомления в Telegram в момент падения монитора — и при восстановлении.",
    icon: "M21 5L3 12l6 2 2 6 3-4 4 3 3-14z",
  },
  {
    title: "Региональные узлы",
    desc: "Запускайте проверки с распределённых узлов, чтобы подтвердить сбой более чем с одной точки.",
    icon: "M12 21s-7-5.5-7-11a7 7 0 1114 0c0 5.5-7 11-7 11zM12 7v3l2 2",
  },
];

const REASONS = [
  {
    title: "Проверка доступности",
    desc: "Узнавайте за секунды, когда сайт или API перестал отвечать, а не от своих пользователей.",
  },
  {
    title: "Контроль задержек",
    desc: "Измеряйте время отклика во времени и ловите медленную деградацию до того, как она станет сбоем.",
  },
  {
    title: "Уведомления о сбоях",
    desc: "Направляйте оповещения в Telegram, чтобы нужные люди узнали о проблеме в момент её появления.",
  },
  {
    title: "История инцидентов",
    desc: "Храните историю проверок и инцидентов, чтобы понимать надёжность и отчитываться по SLA.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="container-page pt-16 pb-20 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <span className="badge mb-5 border border-brand-500/30 bg-brand-500/10 text-brand-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Распределённые узлы · Оповещения в Telegram
          </span>
          <h1 className="text-balance text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-6xl">
            Распределённый мониторинг сайтов, API и инфраструктуры
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-slate-300">
            Мониторинг доступности, задержек, SSL, DNS и здоровья API из разных регионов.
            Мгновенные оповещения в момент сбоя.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="btn-primary px-6 py-3 text-base">
              Начать мониторинг
            </Link>
            <Link href="/pricing" className="btn-secondary px-6 py-3 text-base">
              Смотреть тарифы
            </Link>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Без привязки карты · 7 дней истории на бесплатном тарифе Starter
          </p>
        </div>

        {/* Mock status strip */}
        <div className="card mx-auto mt-16 max-w-4xl p-4 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { name: "api.acme.io", status: "Доступен", ms: "142 мс", color: "emerald" },
              { name: "acme.io", status: "Доступен", ms: "88 мс", color: "emerald" },
              { name: "db.internal:5432", status: "Деградация", ms: "1932 мс", color: "amber" },
            ].map((row) => (
              <div
                key={row.name}
                className="flex items-center justify-between rounded-xl border border-ink-600/70 bg-ink-900/50 px-4 py-3"
              >
                <div>
                  <p className="font-mono text-sm text-slate-200">{row.name}</p>
                  <p className="text-xs text-slate-500">{row.ms}</p>
                </div>
                <span
                  className={`badge ${
                    row.color === "emerald"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-amber-500/15 text-amber-300"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      row.color === "emerald" ? "bg-emerald-400" : "bg-amber-400"
                    }`}
                  />
                  {row.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="container-page py-12">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold text-white">Всё, чтобы следить за вашей инфраструктурой</h2>
          <p className="mt-3 text-slate-400">
            Единая платформа для доступности, производительности и состояния сертификатов.
          </p>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6 transition hover:border-brand-500/40">
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500/10 text-brand-300">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d={f.icon}
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm text-slate-400">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why */}
      <section className="container-page py-12">
        <div className="card overflow-hidden">
          <div className="grid gap-10 p-8 sm:p-12 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold text-white">Зачем командам Sentela</h2>
              <p className="mt-4 text-slate-400">
                Простои стоят дорого, а медленные ответы теряют клиентов. Sentela даёт
                постоянный независимый взгляд на вашу инфраструктуру, чтобы вы реагировали
                раньше, чем заметят пользователи.
              </p>
              <Link href="/register" className="btn-primary mt-8 inline-flex">
                Создать первый монитор
              </Link>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {REASONS.map((r) => (
                <div key={r.title} className="rounded-xl border border-ink-600/70 bg-ink-900/40 p-5">
                  <h3 className="font-semibold text-white">{r.title}</h3>
                  <p className="mt-1.5 text-sm text-slate-400">{r.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container-page py-12">
        <div className="card flex flex-col items-center justify-between gap-6 bg-gradient-to-r from-brand-900/40 to-ink-800 p-10 text-center sm:flex-row sm:text-left">
          <div>
            <h2 className="text-2xl font-bold text-white">Запустите мониторинг за минуты</h2>
            <p className="mt-2 text-slate-300">
              Добавьте URL, выберите интервал проверки, подключите Telegram. Вот и всё.
            </p>
          </div>
          <div className="flex shrink-0 gap-3">
            <Link href="/register" className="btn-primary px-6 py-3">
              Начать мониторинг
            </Link>
            <Link href="/pricing" className="btn-secondary px-6 py-3">
              Смотреть тарифы
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
