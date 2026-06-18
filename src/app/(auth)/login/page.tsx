import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { AuthForm } from "@/components/AuthForm";

export const metadata: Metadata = { title: "Вход" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  if (await getSessionUserId()) redirect("/dashboard");
  return <AuthForm mode="login" next={searchParams.next} />;
}
