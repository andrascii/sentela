import { NextResponse } from "next/server";
import { getPayment, yookassaConfigured } from "@/lib/yookassa";
import { activatePaidPlan, recordPayment } from "@/lib/billing";
import { PLANS } from "@/lib/plans";

// Public endpoint YooKassa calls on payment events. We don't trust the body — we
// re-fetch the payment from the API to confirm its real status, then activate.
export async function POST(req: Request) {
  if (!yookassaConfigured()) return NextResponse.json({ ok: true });

  let body: { event?: string; object?: { id?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const paymentId = body.object?.id;
  if (body.event !== "payment.succeeded" || !paymentId) {
    return NextResponse.json({ ok: true });
  }

  try {
    const p = await getPayment(paymentId); // authoritative
    const userId = Number(p.metadata.user_id);
    const plan = p.metadata.plan;
    const kind = p.metadata.kind === "recurring" ? "recurring" : "initial";
    if (
      p.status === "succeeded" &&
      p.paid &&
      Number.isInteger(userId) &&
      (plan === "pro" || plan === "business")
    ) {
      // Idempotent: only the first time we see this payment activates the period.
      const newly = await recordPayment(
        userId,
        p.id,
        plan,
        PLANS[plan].priceRub,
        "succeeded",
        kind
      );
      if (newly) await activatePaidPlan(userId, plan, p.paymentMethodId, true);
    }
  } catch (err) {
    console.error("[billing] webhook error:", err);
  }

  // Always 200 so YooKassa doesn't retry indefinitely.
  return NextResponse.json({ ok: true });
}
