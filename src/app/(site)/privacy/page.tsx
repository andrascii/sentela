import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Политика конфиденциальности",
  description: "Политика конфиденциальности сервиса Sentela.",
};

export default function PrivacyPage() {
  return (
    <div className="container-page py-16">
      <article className="mx-auto max-w-3xl space-y-6 text-slate-300">
        <h1 className="text-4xl font-bold text-white">Политика конфиденциальности</h1>
        <p className="text-sm text-slate-500">Последнее обновление: 16 июня 2026</p>

        <Section title="Какие данные мы собираем">
          Мы собираем адрес электронной почты и пароль (хранится только в виде хеша с солью),
          которые вы указываете при регистрации, настраиваемые вами мониторы (названия, URL,
          типы и интервалы проверок), результаты выполняемых проверок, а также цели уведомлений
          (например, Telegram chat ID), которые вы добавляете.
        </Section>

        <Section title="Как мы используем данные">
          Мы используем ваши данные для работы Сервиса: выполнения настроенных вами проверок,
          отображения результатов и статистики, доставки оповещений в подключённые каналы. Мы
          не продаём ваши персональные данные.
        </Section>

        <Section title="Уведомления в Telegram">
          Если вы подключаете Telegram chat ID, мы отправляем на него сообщения о сбоях и
          восстановлении через Telegram Bot API. Мы храним указанный вами chat ID, чтобы
          доставлять оповещения.
        </Section>

        <Section title="Срок хранения данных">
          История проверок хранится в соответствии с вашим тарифом (7, 30 или 90 дней), более
          старые записи автоматически удаляются. Данные аккаунта хранятся, пока аккаунт активен.
        </Section>

        <Section title="Безопасность">
          Пароли хешируются с помощью bcrypt и никогда не хранятся в открытом виде. Сессии
          управляются подписанными HTTP-only куками. Мы принимаем разумные меры для защиты
          данных, но ни один способ передачи или хранения не является абсолютно безопасным.
        </Section>

        <Section title="Ваши права">
          Вы можете запросить доступ к своим персональным данным, их исправление или удаление,
          связавшись с нами по контактным данным на странице{" "}
          <a href="/contacts" className="text-brand-300 hover:underline">
            Контакты
          </a>
          .
        </Section>

        <Section title="Изменения">
          Мы можем время от времени обновлять эту политику. О существенных изменениях будет
          сообщаться обновлением даты в верхней части страницы.
        </Section>
      </article>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <p className="leading-relaxed">{children}</p>
    </section>
  );
}
