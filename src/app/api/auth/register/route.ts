import { NextResponse } from "next/server";
import { z } from "zod";
import { createUser, getUserByEmail } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";

const schema = z.object({
  email: z.string().email("Некорректный email").max(254),
  password: z.string().min(8, "Пароль должен содержать минимум 8 символов").max(200),
  plan: z.string().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Некорректные данные" },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;

  const existing = await getUserByEmail(email);
  if (existing) {
    return NextResponse.json(
      { error: "Аккаунт с таким email уже существует" },
      { status: 409 }
    );
  }

  // Every new account starts on the free Starter plan. Paid plans (Pro/Business)
  // are activated only after payment via YooKassa.
  const user = await createUser(email, password);

  await setSessionCookie(user.id);
  return NextResponse.json({ ok: true });
}
