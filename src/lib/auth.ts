import bcrypt from "bcryptjs";
import { query } from "./db";

export interface User {
  id: number;
  email: string;
  status_slug: string | null;
  created_at: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function randomSlug(email: string): string {
  const base = email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "team";
  // Short, URL-safe suffix to keep status-page slugs unique.
  const suffix = Math.abs(hashString(email + ":" + Date.now())).toString(36).slice(0, 6);
  return `${base}-${suffix}`;
}

function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return h;
}

export async function getUserById(id: number): Promise<User | null> {
  const { rows } = await query<User>(
    "SELECT id, email, status_slug, created_at FROM users WHERE id = $1",
    [id]
  );
  return rows[0] ?? null;
}

export async function getUserByEmail(
  email: string
): Promise<(User & { password_hash: string }) | null> {
  const { rows } = await query<User & { password_hash: string }>(
    "SELECT id, email, status_slug, created_at, password_hash FROM users WHERE email = $1",
    [email.toLowerCase()]
  );
  return rows[0] ?? null;
}

export async function createUser(email: string, password: string): Promise<User> {
  const passwordHash = await hashPassword(password);
  const slug = randomSlug(email);
  const { rows } = await query<User>(
    `INSERT INTO users (email, password_hash, status_slug)
     VALUES ($1, $2, $3)
     RETURNING id, email, status_slug, created_at`,
    [email.toLowerCase(), passwordHash, slug]
  );
  const user = rows[0];
  // Every new account starts on the Starter plan (stubbed billing).
  await query(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'starter', 'active')`,
    [user.id]
  );
  // Each user gets a personal team they own, used as the default monitor context.
  const teamRes = await query<{ id: number }>(
    "INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id",
    ["Личная команда", user.id]
  );
  await query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
    [teamRes.rows[0].id, user.id]
  );
  return user;
}
