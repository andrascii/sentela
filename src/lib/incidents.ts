import { query } from "./db";

// Node-safe (no next/* imports) so the standalone ws-server process can reuse
// these helpers for the live collaborative incident timeline.

export interface IncidentComment {
  id: number;
  monitor_id: number | null;
  author_email: string;
  body: string;
  created_at: string;
}

// Bounded so the pg_notify broadcast (JSON envelope + body) stays well under
// Postgres's 8000-byte NOTIFY payload limit even for 4-byte UTF-8 characters.
export const COMMENT_MAX_LENGTH = 1000;

/** Recent team comments, oldest first (chat order). */
export async function listRecentComments(
  teamId: number,
  limit = 50
): Promise<IncidentComment[]> {
  const { rows } = await query<IncidentComment>(
    `SELECT id, monitor_id, author_email, body, created_at
     FROM incident_comments
     WHERE team_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [teamId, limit]
  );
  return rows.reverse();
}

export interface NewComment {
  teamId: number;
  userId: number;
  authorEmail: string;
  monitorId?: number | null;
  body: string;
}

/** Insert a comment and return the stored row (already trimmed/clamped by caller). */
export async function insertIncidentComment(input: NewComment): Promise<IncidentComment> {
  const { rows } = await query<IncidentComment>(
    `INSERT INTO incident_comments (team_id, user_id, author_email, monitor_id, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, monitor_id, author_email, body, created_at`,
    [input.teamId, input.userId, input.authorEmail, input.monitorId ?? null, input.body]
  );
  return rows[0];
}
