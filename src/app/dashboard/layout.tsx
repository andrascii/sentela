import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveTeamId, getTeamOwnerId, getUserTeams } from "@/lib/teams";
import { getPlanCard } from "@/lib/dashboard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [teams, activeTeamId] = await Promise.all([
    getUserTeams(user.id),
    getActiveTeamId(user.id),
  ]);
  const ownerId = (await getTeamOwnerId(activeTeamId)) ?? user.id;
  const planCard = await getPlanCard(ownerId);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        planName={planCard.name}
        planExpiry={planCard.expiry}
        planFree={planCard.free}
        statusSlug={user.status_slug}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar email={user.email} teams={teams} activeTeamId={activeTeamId} />
        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
