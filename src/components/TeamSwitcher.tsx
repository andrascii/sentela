"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface TeamOption {
  id: number;
  name: string;
  role: string;
  member_count: number;
}

export function TeamSwitcher({
  teams,
  activeTeamId,
}: {
  teams: TeamOption[];
  activeTeamId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (teams.length === 0) return null;

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const teamId = Number(e.target.value);
    if (teamId === activeTeamId) return;
    setBusy(true);
    const res = await fetch("/api/teams/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId }),
    });
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <select
      aria-label="Активная команда"
      value={activeTeamId}
      onChange={onChange}
      disabled={busy}
      className="rounded-lg border border-ink-500 bg-ink-900/60 px-2.5 py-1.5 text-sm text-slate-200 focus:border-brand-500 focus:outline-none"
    >
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
          {t.member_count > 1 ? ` · ${t.member_count}` : ""}
        </option>
      ))}
    </select>
  );
}
