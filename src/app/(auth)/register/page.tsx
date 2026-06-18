import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { AuthForm } from "@/components/AuthForm";

export const metadata: Metadata = { title: "Регистрация" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: { plan?: string; next?: string };
}) {
  if (await getSessionUserId()) redirect("/dashboard");
  return <AuthForm mode="register" plan={searchParams.plan} next={searchParams.next} />;
}
