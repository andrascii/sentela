import Link from "next/link";
import type { Metadata } from "next";
import { PLAN_LIST } from "@/lib/plans";
import { getSessionUserId } from "@/lib/session";

export const metadata: Metadata = {
  title: "Тарифы",
  description: "Простые тарифы для мониторинга доступности, API, SSL и DNS.",
};

export const dynamic = "force-dynamic";

function planHref(planId: string, loggedIn: boolean): string {
  if (planId === "starter") return loggedIn ? "/dashboard" : "/register";
  return loggedIn ? "/dashboard/billing" : `/register?plan=${planId}`;
}

export default async function PricingPage() {
  const loggedIn = (await getSessionUserId()) != null;
  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold text-white">Простые и понятные тарифы</h1>
        <p className="mt-3 text-slate-400">
          Выберите тариф под объём инфраструктуры, за которой нужно следить. Цены в рублях,
          оплата помесячно.
        </p>
      </div>

      <div className="mx-auto mt-14 grid max-w-5xl gap-6 lg:grid-cols-3">
        {PLAN_LIST.map((plan) => (
          <div
            key={plan.id}
            className={`card relative flex flex-col p-7 ${
              plan.highlight ? "border-brand-500/60 ring-1 ring-brand-500/40" : ""
            }`}
          >
            {plan.highlight && (
              <span className="badge absolute -top-3 left-7 bg-brand-500 text-white">
                Популярный
              </span>
            )}
            <h2 className="text-xl font-bold text-white">{plan.name}</h2>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-white">{plan.priceRub} ₽</span>
              <span className="text-sm text-slate-400">/ мес</span>
            </div>

            <ul className="mt-6 space-y-3 text-sm text-slate-300">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="mt-0.5 shrink-0 text-brand-400"
                  >
                    <path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

            <div className="mt-8 pt-2">
              <Link
                href={planHref(plan.id, loggedIn)}
                className={plan.highlight ? "btn-primary w-full" : "btn-secondary w-full"}
              >
                {plan.id === "starter" ? "Начать бесплатно" : `Выбрать ${plan.name}`}
              </Link>
            </div>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-slate-500">
        Starter — бесплатно навсегда. Платные тарифы оплачиваются через YooKassa с
        ежемесячным автопродлением; отменить автопродление можно в любой момент в разделе
        «Тариф и оплата».
      </p>
    </div>
  );
}
