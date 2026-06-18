import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { getUserById, type User } from "./auth";

export const SESSION_COOKIE = "ip_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: number): Promise<string> {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(getSecret());
}

export async function setSessionCookie(userId: number): Promise<void> {
  const token = await createSessionToken(userId);
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure cookies require HTTPS. Default on in production; set COOKIE_SECURE=false
    // only for a quick http://IP test deploy (otherwise login silently fails over HTTP).
    secure:
      process.env.COOKIE_SECURE === "false"
        ? false
        : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(): void {
  cookies().delete(SESSION_COOKIE);
}

export async function getSessionUserId(): Promise<number | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const uid = payload.uid;
    return typeof uid === "number" ? uid : null;
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const uid = await getSessionUserId();
  if (uid == null) return null;
  return getUserById(uid);
}
