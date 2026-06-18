import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/session";
import {
  getActiveTeamId,
  getMembership,
  getTeam,
  listMembers,
  listPendingInvites,
} from "@/lib/teams";
import { TeamManager } from "@/components/TeamManager";

export const metadata: Metadata = { title: "Команда" };
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = (await getCurrentUser())!;
  const teamId = await getActiveTeamId(user.id);
  const [team, role, members] = await Promise.all([
    getTeam(teamId),
    getMembership(teamId, user.id),
    listMembers(teamId),
  ]);
  const isOwner = role === "owner";
  const invites = isOwner ? await listPendingInvites(teamId) : [];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Команда</h1>
        <p className="mt-1 text-sm text-slate-400">
          Мониторы видны всем участникам активной команды. Переключайте команды в шапке.
          Публичная статус-страница показывает мониторы вашей личной команды.
        </p>
      </div>

      <TeamManager
        teamId={teamId}
        teamName={team?.name ?? "Команда"}
        role={role ?? "member"}
        currentUserId={user.id}
        members={members}
        invites={invites}
      />
    </div>
  );
}
