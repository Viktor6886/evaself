import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import type { JobOutbox } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobRunJournal } from "../jobs/job-runs.js";
import { EvaError } from "../errors.js";

/** Durable authenticated ingress: user text stays in PostgreSQL, never BullMQ. */
export class ResearchEnqueuer {
  constructor(private readonly db: Database, private readonly jobs: JobOutbox, private readonly runs?: JobRunJournal) {}
  async enqueue(input: { userId: number; conversationId: string; query: string; agentId: string; requestId?: string }): Promise<string> {
    // Отказы исследования — часть контракта API, а не сбой сервера:
    // голая пятисотка не говорит вызывающему, что именно поправить, и
    // выглядит как поломка сервиса.
    if (!input.query.trim() || input.query.length > 4_000) {
      throw new EvaError("Запрос исследования пуст или длиннее 4000 знаков", {
        code: "research_query_invalid", statusCode: 400,
      });
    }
    return await this.db.withUserScope({ userId: input.userId, label: "research.enqueue", inherit: true }, async () => await this.db.transaction(async client => {
      const id = input.requestId ?? randomUUID();
      const verified = await client.query(`SELECT 1 FROM agent_conversations WHERE user_id=$1 AND conversation_id=$2 AND agent_id=$3 AND purpose='research' AND status='active'`, [input.userId, input.conversationId, input.agentId]);
      if (!verified.rows.length) {
        throw new EvaError("Диалог исследования не принадлежит этому пользователю", {
          code: "research_conversation_unauthorized", statusCode: 403,
        });
      }
      await client.query(`INSERT INTO research_requests(id,user_id,conversation_id,agent_id,query,status) VALUES($1,$2,$3,$4,$5,'queued') ON CONFLICT(id) DO NOTHING`, [id, input.userId, input.conversationId, input.agentId, input.query.trim()]);
      await this.jobs.record(client, { type:"research_run", queue:"research", userId:input.userId, conversationId:input.conversationId, agentId:input.agentId, traceId:id, correlationId:id, idempotencyKey:jobIdempotencyKey({type:"research_run",userId:input.userId,discriminator:id}), payloadRef:id, payload:{request_id:id}, deadlineMs:15*60_000, timezone:"UTC", source:"user", privacy:"restricted" });
      return id;
    }));
  }
  async status(userId:number,id:string){const{rows}=await this.db.withUserScope({userId,label:"research.status",inherit:true},async()=>await this.db.query("SELECT id,status,report_id,created_at,completed_at FROM research_requests WHERE id=$1 AND user_id=$2",[id,userId]));return rows[0]??null;}
  async report(userId:number,id:string){const{rows}=await this.db.withUserScope({userId,label:"research.report",inherit:true},async()=>await this.db.query("SELECT p.report_json FROM research_requests r JOIN research_reports p ON p.id=r.report_id AND p.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND p.status='completed'",[id,userId]));return rows[0]?.report_json??null;}
  async cancel(userId:number,id:string){const requested=await this.runs?.requestCancelByCorrelation(id,userId,randomUUID())??false;return await this.db.withUserScope({userId,label:"research.cancel",inherit:true},async()=>await this.db.transaction(async client=>{const result=await client.query("UPDATE research_requests SET status='cancelled',completed_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('queued','processing') RETURNING id",[id,userId]);return Boolean(result.rows[0])||requested;}));}
}
