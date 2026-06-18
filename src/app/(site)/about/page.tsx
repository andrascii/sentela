import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "О сервисе и инфраструктуре",
  description:
    "Как работает Sentela: распределённые узлы мониторинга, проверки доступности, измерение задержек, проверка SSL и DNS.",
};

export default function AboutPage() {
  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-4xl font-bold text-white">О сервисе Sentela</h1>
        <p className="mt-4 text-lg text-slate-300">
          Sentela — платформа мониторинга сайтов, API и инфраструктуры. Она выполняет
          плановые проверки доступности, измеряет задержки, проверяет SSL-сертификаты и
          резолвит DNS, а затем оповещает вас в Telegram при изменениях.
        </p>

        <section className="mt-12">
          <h2 className="text-2xl font-semibold text-white">Что делает платформа</h2>
          <ul className="mt-4 space-y-2 text-slate-300">
            <li>• Периодические HTTP/HTTPS-проверки доступности и задержек сайтов и API.</li>
            <li>• Проверки доступности TCP-портов для баз данных и внутренних сервисов.</li>
            <li>• DNS-проверки для обнаружения ошибок конфигурации и проблем распространения.</li>
            <li>• Проверка SSL/TLS-сертификатов с предупреждениями об истечении.</li>
            <li>• Уведомления в Telegram при сбое и восстановлении.</li>
            <li>• Статистика доступности и история инцидентов по каждому монитору.</li>
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-semibold text-white">Инфраструктура и сетевая нагрузка</h2>
          <div className="card mt-4 space-y-4 p-6 text-slate-300">
            <p>
              Платформа выполняет регулярные проверки доступности сайтов, API и сетевых
              сервисов из распределённых инфраструктурных узлов. Сетевая нагрузка формируется
              за счёт мониторинговых проверок, диагностики задержек, проверки SSL-сертификатов,
              DNS-запросов и пользовательских API-проверок.
            </p>
            <p className="border-t border-ink-600/70 pt-4 text-slate-400">
              Our platform performs continuous availability checks, API diagnostics and latency
              measurements from distributed infrastructure nodes. Network traffic is generated
              by scheduled monitoring probes, regional health checks, SSL verification, DNS
              lookups and customer-configured API checks.
            </p>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Проверки — это одиночные низкочастотные запросы, ограниченные настроенным интервалом
            каждого монитора (60 секунд и больше) и лимитами мониторов по тарифу. Sentela —
            это инструмент диагностики; он не предназначен и не разрешён для нагрузочного,
            стресс-тестирования или генерации высокообъёмного трафика к сторонним целям.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-semibold text-white">Допустимое использование</h2>
          <p className="mt-4 text-slate-300">
            Вы можете мониторить только те системы, которыми владеете или на мониторинг которых
            у вас есть явное разрешение. Использование Sentela для проверки или перегрузки
            инфраструктуры без разрешения запрещено и может привести к блокировке аккаунта.
          </p>
        </section>
      </div>
    </div>
  );
}
