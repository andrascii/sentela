import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { AcceptInviteButton } from "@/components/AcceptInviteButton";
import { getSessionUserId } from "@/lib/session";
import { getInviteByToken } from "@/lib/teams";

export const metadata: Metadata = { title: "Приглашение в команду" };
export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: { token: string };
}) {
  const invite = await getInviteByToken(params.token);
  const userId = await getSessionUserId();
  const next = `/invite/${params.token}`;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <div className="card w-full max-w-md p-8 text-center">
        {!invite ? (
          <>
            <h1 className="text-xl font-bold text-white">Приглашение не найдено</h1>
            <p className="mt-2 text-sm text-slate-400">
              Ссылка недействительна. Попросите владельца команды отправить новое приглашение.
            </p>
          </>
        ) : invite.accepted ? (
          <>
            <h1 className="text-xl font-bold text-white">Приглашение уже использовано</h1>
            <p className="mt-2 text-sm text-slate-400">
              Это приглашение в команду «{invite.team_name}» уже принято.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-white">
              Приглашение в команду «{invite.team_name}»
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              Вас пригласили присоединиться по адресу {invite.email}.
            </p>
            <div className="mt-6">
              {userId != null ? (
                <AcceptInviteButton token={params.token} />
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-slate-400">
                    Войдите или создайте аккаунт, чтобы принять приглашение.
                  </p>
                  <Link
                    href={`/login?next=${encodeURIComponent(next)}`}
                    className="btn-primary w-full"
                  >
                    Войти
                  </Link>
                  <Link
                    href={`/register?next=${encodeURIComponent(next)}`}
                    className="btn-secondary w-full"
                  >
                    Создать аккаунт
                  </Link>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
