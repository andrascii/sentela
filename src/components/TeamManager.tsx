"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Member {
  user_id: number;
  email: string;
  role: string;
}
interface Invite {
  id: number;
  email: string;
  token: string;
}

export function TeamManager({
  teamId,
  teamName,
  role,
  currentUserId,
  members,
  invites,
}: {
  teamId: number;
  teamName: string;
  role: string;
  currentUserId: number;
  members: Member[];
  invites: Invite[];
}) {
  const router = useRouter();
  const isOwner = role === "owner";

  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setInviteLink(null);
    const res = await fetch(`/api/teams/${teamId}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: data.error || "Не удалось пригласить" });
      return;
    }
    const r = data.result;
    if (r?.kind === "added") {
      setMsg({ kind: "ok", text: `${r.email} добавлен(а) в команду` });
      setEmail("");
      router.refresh();
    } else if (r?.kind === "already_member") {
      setMsg({ kind: "err", text: `${r.email} уже в команде` });
    } else if (r?.kind === "invited") {
      setInviteLink(`${origin}/invite/${r.token}`);
      setMsg({
        kind: "ok",
        text: `У ${r.email} ещё нет аккаунта — отправьте ссылку-приглашение`,
      });
      setEmail("");
      router.refresh();
    }
  }

  async function removeMember(userId: number) {
    setBusy(true);
    const res = await fetch(`/api/teams/${teamId}/members/${userId}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (res.ok) router.refresh();
  }

  async function revokeInvite(inviteId: number) {
    setBusy(true);
    const res = await fetch(`/api/teams/${teamId}/invites/${inviteId}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (res.ok) router.refresh();
  }

  async function leaveTeam() {
    setBusy(true);
    const res = await fetch(`/api/teams/${teamId}/leave`, { method: "POST" });
    setBusy(false);
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  return (
    <div className="space-y-8">
      {/* Members */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-ink-600/70 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">Участники команды «{teamName}»</h2>
          {!isOwner && (
            <button className="btn-danger text-sm" onClick={leaveTeam} disabled={busy}>
              Покинуть команду
            </button>
          )}
        </div>
        <ul className="divide-y divide-ink-700/60">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between px-6 py-3.5">
              <div>
                <span className="text-sm text-white">{m.email}</span>
                {m.user_id === currentUserId && (
                  <span className="ml-2 text-xs text-slate-500">(вы)</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`badge ${
                    m.role === "owner"
                      ? "bg-brand-500/15 text-brand-300"
                      : "bg-slate-500/15 text-slate-300"
                  }`}
                >
                  {m.role === "owner" ? "Владелец" : "Участник"}
                </span>
                {isOwner && m.role !== "owner" && (
                  <button
                    className="text-xs text-red-300 hover:underline"
                    onClick={() => removeMember(m.user_id)}
                    disabled={busy}
                  >
                    Удалить
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Invite */}
      {isOwner && (
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-white">Пригласить участника</h2>
          <p className="mt-1 text-sm text-slate-400">
            Если у пользователя уже есть аккаунт Sentela, он будет добавлен сразу. Иначе вы
            получите ссылку-приглашение.
          </p>
          <form onSubmit={invite} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="email"
              required
              className="input"
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="btn-primary shrink-0" disabled={busy}>
              Пригласить
            </button>
          </form>

          {msg && (
            <p
              className={`mt-3 text-sm ${
                msg.kind === "ok" ? "text-emerald-300" : "text-red-300"
              }`}
            >
              {msg.text}
            </p>
          )}
          {inviteLink && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-ink-600/70 bg-ink-900/50 px-3 py-2">
              <code className="flex-1 truncate text-xs text-brand-300">{inviteLink}</code>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => copy(inviteLink)}
              >
                Копировать
              </button>
            </div>
          )}

          {invites.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                Ожидающие приглашения
              </h3>
              <ul className="space-y-2">
                {invites.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-ink-600/70 bg-ink-900/40 px-3 py-2"
                  >
                    <span className="text-sm text-slate-300">{inv.email}</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        className="text-xs text-slate-400 hover:text-white"
                        onClick={() => copy(`${origin}/invite/${inv.token}`)}
                      >
                        Копировать ссылку
                      </button>
                      <button
                        type="button"
                        className="text-xs text-red-300 hover:underline"
                        onClick={() => revokeInvite(inv.id)}
                        disabled={busy}
                      >
                        Отозвать
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <CreateTeam />
    </div>
  );
}

function CreateTeam() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (res.ok) {
      setName("");
      router.push("/dashboard/team");
      router.refresh();
    }
  }

  return (
    <section className="card p-6">
      <h2 className="text-lg font-semibold text-white">Создать новую команду</h2>
      <p className="mt-1 text-sm text-slate-400">
        Заведите отдельную команду и переключайтесь между ними в шапке.
      </p>
      <form onSubmit={create} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          required
          maxLength={80}
          className="input"
          placeholder="Название команды"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn-secondary shrink-0" disabled={busy}>
          Создать команду
        </button>
      </form>
    </section>
  );
}
