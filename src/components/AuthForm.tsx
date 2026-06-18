"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface AuthFormProps {
  mode: "login" | "register";
  plan?: string;
  next?: string;
}

export function AuthForm({ mode, plan, next }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isRegister = mode === "register";
  const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          isRegister ? { email, password, plan } : { email, password }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Что-то пошло не так");
        setLoading(false);
        return;
      }
      // New users who picked a paid plan land on billing to pay; others on dashboard.
      const dest =
        next && next.startsWith("/")
          ? next
          : isRegister && plan && plan !== "starter"
            ? "/dashboard/billing"
            : "/dashboard";
      router.push(dest);
      router.refresh();
    } catch {
      setError("Ошибка сети — попробуйте ещё раз");
      setLoading(false);
    }
  }

  return (
    <div className="card p-8">
      <h1 className="text-2xl font-bold text-white">
        {isRegister ? "Создайте аккаунт" : "С возвращением"}
      </h1>
      <p className="mt-1.5 text-sm text-slate-400">
        {isRegister
          ? "Начните мониторинг сайтов и API за пару минут."
          : "Войдите в свою панель Sentela."}
      </p>

      {isRegister && plan && (
        <p className="mt-3 inline-flex rounded-lg bg-brand-500/10 px-3 py-1.5 text-xs text-brand-300">
          Выбранный тариф: <span className="ml-1 font-semibold capitalize">{plan}</span>
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Пароль
          </label>
          <input
            id="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            required
            minLength={isRegister ? 8 : undefined}
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isRegister ? "Минимум 8 символов" : "••••••••"}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? "Подождите…" : isRegister ? "Создать аккаунт" : "Войти"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        {isRegister ? (
          <>
            Уже есть аккаунт?{" "}
            <Link href="/login" className="text-brand-300 hover:underline">
              Войти
            </Link>
          </>
        ) : (
          <>
            Нет аккаунта?{" "}
            <Link href="/register" className="text-brand-300 hover:underline">
              Создать
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
