import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/session";
import { getSubscription, effectivePlanId, listPayments } from "@/lib/billing";
import { yookassaConfigured } from "@/lib/yookassa";
import { PLAN_LIST, PLANS, getPlan } from "@/lib/plans";
import { SubscribeButton, CancelRenewButton } from "@/components/BillingActions";
import { formatDate, formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Тариф и оплата" };
export const dynamic = "force-dynamic";

function daysLeft(expires: string | null): number | null {
  if (!expires) return null;
  const ms = new Date(expires).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 86400000) : 0;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { paid?: string };
}) {
  const user = (await getCurrentUser())!;
  const [sub, payments] = await Promise.all([
    getSubscription(user.id),
    listPayments(user.id),
  ]);
  const effective = effectivePlanId(sub);
  const currentPlan = PLANS[effective];
  const billingReady = yookassaConfigured();
  const left = daysLeft(sub?.expires_at ?? null);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Тариф и оплата</h1>
        <p className="mt-1 text-sm text-slate-400">
          Управление подпиской. Оплата проходит через YooKassa — карты вводятся на их
          стороне, мы их не храним.
        </p>
      </div>

      {searchParams.paid === "1" && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          Оплата принята. Тариф активируется в течение пары минут после подтверждения от
          YooKassa — обновите страницу.
        </div>
      )}

      {!billingReady && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Оплата ещё не настроена (нет ключей YooKassa в окружении). Платные тарифы пока
          недоступны для покупки.
        </div>
      )}

      {/* Current subscription */}
      <div className="card p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Текущий тариф</p>
            <p className="mt-1 text-2xl font-bold text-white">{currentPlan.name}</p>
            <p className="mt-1 text-sm text-slate-400">
              {effective === "starter" ? (
                "Бесплатный тариф"
              ) : left != null ? (
                <>
                  Активен до {formatDate(sub?.expires_at ?? null)} ·{" "}
                  <span className="text-slate-300">{left} дн.</span>
                </>
              ) : (
                "Активен"
              )}
            </p>
          </div>
          <div className="text-right">
            {effective !== "starter" && (
              <>
                <p className="text-sm text-slate-400">
                  Автопродление:{" "}
                  <span className={sub?.auto_renew ? "text-emerald-300" : "text-slate-300"}>
                    {sub?.auto_renew ? "включено" : "выключено"}
                  </span>
                </p>
                {sub?.auto_renew && (
                  <div className="mt-2">
                    <CancelRenewButton />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Plans */}
      <div className="grid gap-4 lg:grid-cols-3">
        {PLAN_LIST.map((plan) => {
          const isCurrent = plan.id === effective;
          return (
            <div
              key={plan.id}
              className={`card flex flex-col p-6 ${
                isCurrent ? "border-brand-500/60 ring-1 ring-brand-500/40" : ""
              }`}
            >
              <h2 className="text-lg font-bold text-white">{plan.name}</h2>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-extrabold text-white">{plan.priceRub} ₽</span>
                <span className="text-sm text-slate-400">/ мес</span>
              </div>
              <ul className="mt-5 flex-1 space-y-2 text-sm text-slate-300">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-brand-400">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                {isCurrent ? (
                  <button disabled className="btn-secondary w-full opacity-60">
                    Текущий тариф
                  </button>
                ) : plan.id === "starter" ? (
                  <p className="text-center text-xs text-slate-500">
                    Включается автоматически после окончания платного периода
                  </p>
                ) : billingReady ? (
                  <SubscribeButton plan={plan.id as "pro" | "business"}>
                    {effective === "starter" ? "Подключить" : "Перейти"} · {plan.priceRub} ₽/мес
                  </SubscribeButton>
                ) : (
                  <button disabled className="btn-secondary w-full opacity-60">
                    Оплата не настроена
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Payment history */}
      <div className="card overflow-hidden">
        <h2 className="border-b border-ink-600/70 px-6 py-4 text-lg font-semibold text-white">
          История платежей
        </h2>
        {payments.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">Платежей пока нет.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-ink-700/60">
                <th className="px-6 py-3 font-semibold">Дата</th>
                <th className="px-6 py-3 font-semibold">Тариф</th>
                <th className="px-6 py-3 font-semibold">Сумма</th>
                <th className="px-6 py-3 font-semibold">Тип</th>
                <th className="px-6 py-3 font-semibold">Статус</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/50">
              {payments.map((p) => (
                <tr key={p.id} className="text-slate-300">
                  <td className="whitespace-nowrap px-6 py-3 text-slate-400">
                    {formatDateTime(p.created_at)}
                  </td>
                  <td className="px-6 py-3">{getPlan(p.plan).name}</td>
                  <td className="px-6 py-3">{p.amount_rub} ₽</td>
                  <td className="px-6 py-3 text-slate-400">
                    {p.kind === "recurring" ? "автопродление" : "первичный"}
                  </td>
                  <td className="px-6 py-3">
                    <span className="badge bg-emerald-500/15 text-emerald-300">{p.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
