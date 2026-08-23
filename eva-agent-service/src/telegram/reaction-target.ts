import type pg from "pg";

import type { Database } from "../db.js";
import type { ReactionTarget } from "../turns/turn-context.js";

type QueryClient = Pick<pg.PoolClient, "query">;

/** One lock domain shared by webhook acceptance and reaction delivery. */
export function reactionTargetLockKey(userId: number, chatId: number): string {
  return `telegram-reaction:${userId}:${chatId}`;
}

export async function lockReactionTarget(
  client: QueryClient,
  userId: number,
  chatId: number,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
    reactionTargetLockKey(userId, chatId),
  ]);
}

/**
 * Verify that every server-owned coordinate still names the same real
 * inbound message. A later update is unrelated: Telegram can react to A
 * after B arrives, and replacing A with B would be the unsafe operation.
 * Turn completion/cancellation is guarded by the turn lifecycle before the
 * tool executes, not inferred from inbox ordering.
 */
export async function matchesReactionTarget(
  client: QueryClient,
  target: ReactionTarget,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `
      -- tenant: system — validate the exact server-owned durable Telegram target
      SELECT 1
        FROM telegram_updates
       WHERE update_id = $1
         AND telegram_user_id = $2
         AND chat_id = $3
         AND message_id = $4
         AND (payload ? 'message' OR payload ? 'edited_message')
         AND COALESCE(
               payload #>> '{message,from,is_bot}',
               payload #>> '{edited_message,from,is_bot}',
               'false'
             ) <> 'true'
       LIMIT 1`,
    [target.updateId, target.telegramUserId, target.chatId, target.messageId],
  );
  return (rowCount ?? 0) > 0;
}

/** Cheap identity check; physical delivery repeats it while holding the shared lock. */
export async function isReactionTargetTrusted(
  db: Database,
  target: ReactionTarget,
): Promise<boolean> {
  return await db.withSystemScope(
    "telegram.reaction.target",
    async () => await matchesReactionTarget(db as unknown as QueryClient, target),
    { crossUser: true },
  );
}
