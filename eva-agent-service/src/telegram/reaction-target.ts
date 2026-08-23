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

/** A newer real inbound message makes the old target stale; synthetic updates do not. */
export async function hasNewerRealMessage(
  client: QueryClient,
  target: ReactionTarget,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `
      -- tenant: system — freshness spans durable Telegram ingress for one trusted user/chat pair
      SELECT 1
        FROM telegram_updates
       WHERE telegram_user_id = $1
         AND chat_id = $2
         AND update_id > $3
         AND (payload ? 'message' OR payload ? 'edited_message')
         AND COALESCE(
               payload #>> '{message,from,is_bot}',
               payload #>> '{edited_message,from,is_bot}',
               'false'
             ) <> 'true'
       LIMIT 1`,
    [target.telegramUserId, target.chatId, target.updateId],
  );
  return (rowCount ?? 0) > 0;
}

/** Cheap pre-enqueue check; physical delivery repeats it while holding the shared lock. */
export async function isReactionTargetFresh(
  db: Database,
  target: ReactionTarget,
): Promise<boolean> {
  return await db.withSystemScope(
    "telegram.reaction.freshness",
    async () => !await hasNewerRealMessage(db as unknown as QueryClient, target),
    { crossUser: true },
  );
}
