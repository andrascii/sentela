import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getActivePlanId, listGroupNames } from "@/lib/monitors";
import { getActiveTeamId, getTeamOwnerId } from "@/lib/teams";
import { PLANS } from "@/lib/plans";
import { AddMonitorForm } from "@/components/AddMonitorForm";

export const metadata: Metadata = { title: "Добавить монитор" };

export default async function NewMonitorPage() {
  const user = (await getCurrentUser())!;
  const teamId = await getActiveTeamId(user.id);
  const ownerId = (await getTeamOwnerId(teamId)) ?? user.id;
  const [planId, groups] = await Promise.all([
    getActivePlanId(ownerId),
    listGroupNames(teamId),
  ]);
  const plan = PLANS[planId];

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <Link href="/dashboard" className="text-sm text-slate-400 hover:text-white">
          ← Назад к мониторам
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-white">Добавить монитор</h1>
        <p className="mt-1 text-sm text-slate-400">
          Настройте новую проверку доступности. Она будет выполняться автоматически по
          выбранному вами расписанию.
        </p>
      </div>
      <AddMonitorForm minIntervalSeconds={plan.minIntervalSeconds} groups={groups} />
    </div>
  );
}
