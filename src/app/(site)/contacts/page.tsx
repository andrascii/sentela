import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Контакты",
  description: "Контактные данные оператора сервиса Sentela.",
};

export default function ContactsPage() {
  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-4xl font-bold text-white">Контакты</h1>
        <p className="mt-4 text-slate-300">
          Сервис Sentela предоставляется индивидуальным предпринимателем (ИП). Замените
          приведённые ниже данные-заглушки на реальные регистрационные данные перед запуском в
          продакшен.
        </p>

        <div className="card mt-8 divide-y divide-ink-600/70">
          <Row label="Оператор" value="ИП Фамилия Имя Отчество (заглушка)" />
          <Row label="ОГРНИП" value="000000000000000 (заглушка)" />
          <Row label="ИНН" value="000000000000 (заглушка)" />
          <Row label="Email" value="support@sentela.example" isEmail />
          <Row label="Часы поддержки" value="Пн–Пт, 10:00–19:00 МСК" />
          <Row label="Время ответа" value="В течение 1 рабочего дня" />
        </div>

        <div className="card mt-6 p-6 text-sm text-slate-400">
          <p>
            По запросам о защите персональных данных (доступ, исправление, удаление) напишите
            нам с темой письма «Запрос о персональных данных» с адреса, привязанного к вашему
            аккаунту. См.{" "}
            <a href="/privacy" className="text-brand-300 hover:underline">
              Политику конфиденциальности
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  isEmail,
}: {
  label: string;
  value: string;
  isEmail?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm font-medium text-slate-400">{label}</span>
      {isEmail ? (
        <a href={`mailto:${value}`} className="font-mono text-sm text-brand-300 hover:underline">
          {value}
        </a>
      ) : (
        <span className="text-sm text-slate-200">{value}</span>
      )}
    </div>
  );
}
