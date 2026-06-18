import { query } from "./db";

export interface ChannelRow {
  id: number;
  user_id: number;
  type: string;
  target: string;
  created_at: string;
}

export async function listChannels(userId: number): Promise<ChannelRow[]> {
  const { rows } = await query<ChannelRow>(
    "SELECT * FROM notification_channels WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return rows;
}

/** Add a channel, ignoring exact duplicates for the same user. */
export async function addChannel(
  userId: number,
  type: string,
  target: string
): Promise<ChannelRow | null> {
  const existing = await query<ChannelRow>(
    "SELECT * FROM notification_channels WHERE user_id = $1 AND type = $2 AND target = $3",
    [userId, type, target]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await query<ChannelRow>(
    `INSERT INTO notification_channels (user_id, type, target)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, type, target]
  );
  return rows[0] ?? null;
}

export async function deleteChannel(id: number, userId: number): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM notification_channels WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return (rowCount ?? 0) > 0;
}
