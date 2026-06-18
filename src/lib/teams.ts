import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { query } from "./db";

export const TEAM_COOKIE = "ip_team";

export type TeamRole = "owner" | "member";

export interface Team {
  id: number;
  name: string;
  owner_id: number;
  created_at: string;
}

export interface UserTeam {
  id: number;
  name: string;
  owner_id: number;
  role: TeamRole;
  owner_email: string;
  member_count: number;
}

export interface MemberRow {
  user_id: number;
  email: string;
  role: TeamRole;
  created_at: string;
}

export interface InviteRow {
  id: number;
  email: string;
  role: TeamRole;
  token: string;
  created_at: string;
}

/** The personal team a user owns (created at registration). */
export async function getPersonalTeamId(userId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    "SELECT id FROM teams WHERE owner_id = $1 ORDER BY id ASC LIMIT 1",
    [userId]
  );
  return rows[0]?.id ?? null;
}

export async function getTeam(teamId: number): Promise<Team | null> {
  const { rows } = await query<Team>("SELECT * FROM teams WHERE id = $1", [teamId]);
  return rows[0] ?? null;
}

export async function getTeamOwnerId(teamId: number): Promise<number | null> {
  const { rows } = await query<{ owner_id: number }>(
    "SELECT owner_id FROM teams WHERE id = $1",
    [teamId]
  );
  return rows[0]?.owner_id ?? null;
}

export async function getUserTeams(userId: number): Promise<UserTeam[]> {
  const { rows } = await query<UserTeam>(
    `SELECT t.id, t.name, t.owner_id, m.role,
            ou.email AS owner_email,
            (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
     FROM team_members m
     JOIN teams t ON t.id = m.team_id
     JOIN users ou ON ou.id = t.owner_id
     WHERE m.user_id = $1
     ORDER BY (t.owner_id = $1) DESC, t.name ASC`,
    [userId]
  );
  return rows;
}

export async function getMembership(
  teamId: number,
  userId: number
): Promise<TeamRole | null> {
  const { rows } = await query<{ role: TeamRole }>(
    "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
    [teamId, userId]
  );
  return rows[0]?.role ?? null;
}

/** Active team from the cookie, validated against membership; falls back to personal team. */
export async function getActiveTeamId(userId: number): Promise<number> {
  const raw = cookies().get(TEAM_COOKIE)?.value;
  if (raw) {
    const id = parseInt(raw, 10);
    if (Number.isInteger(id)) {
      const role = await getMembership(id, userId);
      if (role) return id;
    }
  }
  const personal = await getPersonalTeamId(userId);
  if (personal != null) return personal;
  // Read-only fallback: any team the user is a member of.
  const member = await query<{ team_id: number }>(
    "SELECT team_id FROM team_members WHERE user_id = $1 ORDER BY team_id ASC LIMIT 1",
    [userId]
  );
  if (member.rows[0]) return member.rows[0].team_id;
  // Last resort (should never happen — users get a personal team at registration).
  return createTeam("Личная команда", userId);
}

export function setActiveTeamCookie(teamId: number): void {
  cookies().set(TEAM_COOKIE, String(teamId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function createTeam(name: string, ownerId: number): Promise<number> {
  const { rows } = await query<{ id: number }>(
    "INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id",
    [name, ownerId]
  );
  const teamId = rows[0].id;
  await query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (team_id, user_id) DO NOTHING`,
    [teamId, ownerId]
  );
  return teamId;
}

export async function listMembers(teamId: number): Promise<MemberRow[]> {
  const { rows } = await query<MemberRow>(
    `SELECT m.user_id, u.email, m.role, m.created_at
     FROM team_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1
     ORDER BY (m.role = 'owner') DESC, u.email ASC`,
    [teamId]
  );
  return rows;
}

export async function listPendingInvites(teamId: number): Promise<InviteRow[]> {
  const { rows } = await query<InviteRow>(
    `SELECT id, email, role, token, created_at
     FROM team_invites
     WHERE team_id = $1 AND accepted_at IS NULL
     ORDER BY created_at DESC`,
    [teamId]
  );
  return rows;
}

export type InviteResult =
  | { kind: "added"; email: string }
  | { kind: "invited"; token: string; email: string }
  | { kind: "already_member"; email: string };

/** Invite by email: adds the user immediately if they already have an account, else creates a token. */
export async function inviteToTeam(
  teamId: number,
  rawEmail: string,
  invitedBy: number
): Promise<InviteResult> {
  const email = rawEmail.trim().toLowerCase();

  const userRes = await query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );
  const existing = userRes.rows[0];

  if (existing) {
    const role = await getMembership(teamId, existing.id);
    if (role) return { kind: "already_member", email };
    await query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, existing.id]
    );
    return { kind: "added", email };
  }

  // Reuse an existing pending invite for the same email if present.
  const pending = await query<{ token: string }>(
    "SELECT token FROM team_invites WHERE team_id = $1 AND email = $2 AND accepted_at IS NULL",
    [teamId, email]
  );
  if (pending.rows[0]) return { kind: "invited", token: pending.rows[0].token, email };

  const token = randomBytes(24).toString("hex");
  await query(
    `INSERT INTO team_invites (team_id, email, role, token, invited_by)
     VALUES ($1, $2, 'member', $3, $4)`,
    [teamId, email, token, invitedBy]
  );
  return { kind: "invited", token, email };
}

export interface InviteInfo {
  team_id: number;
  team_name: string;
  email: string;
  accepted: boolean;
}

export async function getInviteByToken(token: string): Promise<InviteInfo | null> {
  const { rows } = await query<InviteInfo>(
    `SELECT i.team_id, t.name AS team_name, i.email,
            (i.accepted_at IS NOT NULL) AS accepted
     FROM team_invites i JOIN teams t ON t.id = i.team_id
     WHERE i.token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

export type AcceptResult =
  | { ok: true; teamId: number }
  | { ok: false; reason: "invalid" | "email_mismatch" };

/**
 * Accept an invite as the logged-in user. The invite is bound to the address it
 * was issued for: the accepting user's email must match, so a forwarded/leaked
 * link cannot be used by someone else to join the team.
 */
export async function acceptInvite(token: string, userId: number): Promise<AcceptResult> {
  const { rows } = await query<{
    id: number;
    team_id: number;
    email: string;
    accepted_at: string | null;
  }>(
    "SELECT id, team_id, email, accepted_at FROM team_invites WHERE token = $1",
    [token]
  );
  const invite = rows[0];
  if (!invite || invite.accepted_at) return { ok: false, reason: "invalid" };

  const userRes = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1",
    [userId]
  );
  const userEmail = userRes.rows[0]?.email?.toLowerCase();
  if (!userEmail || userEmail !== invite.email.toLowerCase()) {
    return { ok: false, reason: "email_mismatch" };
  }

  await query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (team_id, user_id) DO NOTHING`,
    [invite.team_id, userId]
  );
  await query("UPDATE team_invites SET accepted_at = now() WHERE id = $1", [invite.id]);
  return { ok: true, teamId: invite.team_id };
}

export async function revokeInvite(teamId: number, inviteId: number): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM team_invites WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL",
    [inviteId, teamId]
  );
  return (rowCount ?? 0) > 0;
}

/** Remove a member (cannot remove the owner). */
export async function removeMember(teamId: number, userId: number): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM team_members
     WHERE team_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [teamId, userId]
  );
  return (rowCount ?? 0) > 0;
}
