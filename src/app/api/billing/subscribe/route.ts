import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { createPayment, yookassaConfigured } from "@/lib/yookassa";
import { PLANS } from "@/lib/plans";

const schema = z.object({ plan: z.enum(["pro", "business"]) });

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }
  if (!yookassaConfigured()) {
    return NextResponse.json(
      { error: "Оплата ещё не настроена (нет ключей YooKassa)." },
      { status: 503 }
    );
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Некорректный тариф" }, { status: 400 });
  }
  const plan = parsed.data.plan;
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

  try {
    const payment = await createPayment({
      amountRub: PLANS[plan].priceRub,
      description: `Sentela ${PLANS[plan].name} — подписка на месяц`,
      returnUrl: `${base}/dashboard/billing?paid=1`,
      metadata: { user_id: String(userId), plan, kind: "initial" },
      savePaymentMethod: true,
    });
    if (!payment.confirmationUrl) {
      return NextResponse.json({ error: "Не удалось создать платёж" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, confirmationUrl: payment.confirmationUrl });
  } catch (err) {
    console.error("[billing] subscribe error:", err);
    return NextResponse.json(
      { error: "Ошибка платёжного провайдера, попробуйте позже" },
      { status: 502 }
    );
  }
}
