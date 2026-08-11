/**
 * Фейковая база для тестов памяти.
 *
 * PostgreSQL в тестах сервиса подменяется — так же, как в остальных
 * наборах. Фейк повторяет ПРАВИЛА выборки (уникальные ключи, отбор по
 * периоду действительности, ON CONFLICT DO NOTHING), но не сам SQL:
 * семантика индексов проверяется в CI на настоящей базе.
 */

export interface FakeRow {
  [column: string]: unknown;
}

interface Table {
  rows: FakeRow[];
  sequence: number;
}

const TIME = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value === "number") return value;
  return Number.NaN;
};

export class MemoryFakeDb {
  readonly tables = new Map<string, Table>();
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  /** Запросы, выполненные без предиката владельца, — граница арендатора. */
  readonly unscoped: string[] = [];

  private table(name: string): Table {
    let table = this.tables.get(name);
    if (!table) {
      table = { rows: [], sequence: 0 };
      this.tables.set(name, table);
    }
    return table;
  }

  rowsOf(name: string): FakeRow[] {
    return this.table(name).rows;
  }

  seed(name: string, row: FakeRow): FakeRow {
    const table = this.table(name);
    table.sequence += 1;
    const stored = { id: String(table.sequence), ...row };
    table.rows.push(stored);
    return stored;
  }

  async transaction<T>(work: (client: MemoryFakeDb) => Promise<T>): Promise<T> {
    return await work(this);
  }

  async withUserScope<T>(_scope: unknown, work: () => Promise<T>): Promise<T> {
    return await work();
  }

  async withSystemScope<T>(_label: string, work: () => Promise<T>): Promise<T> {
    return await work();
  }

  async query<T = FakeRow>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, values });
    // Комментарии снимаются ДО схлопывания пробелов: иначе однострочный
    // `--` съел бы весь оставшийся запрос, превратившийся в одну строку.
    const text = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // Границу арендатора нарушает выборка или изменение без предиката
    // владельца. У INSERT владелец — сам столбец, поэтому вставки сюда
    // не попадают.
    if (!text.startsWith("INSERT")
      && /\b(memory_nodes|memory_node_versions|memory_evidence|memory_edges|memory_edge_versions|memory_conflicts|memory_entity_aliases|memory_entity_merges|memory_episodes|memory_curator_runs)\b/.test(text)
      && !/user_id = \$1/.test(text) && !/backfill/.test(text) && !/id > \$1/.test(text)) {
      this.unscoped.push(text);
    }
    const result = this.dispatch(text, values);
    return { rows: result as T[], rowCount: result.length };
  }

  private dispatch(sql: string, values: unknown[]): FakeRow[] {
    // DELETE разбирается ПЕРВЫМ: «DELETE FROM memory_evidence» содержит
    // «FROM memory_evidence», и любая проверка по подстроке ниже увела
    // бы удаление в выборку — молча и без единой удалённой строки.
    if (sql.startsWith("DELETE FROM")) return this.deleteRows(sql, values);
    if (sql.startsWith("SELECT") && sql.includes("FROM memory_nodes")) return this.selectNodes(sql, values);
    if (sql.startsWith("INSERT INTO memory_nodes")) return this.insertNode(values);
    if (sql.startsWith("UPDATE memory_nodes")) return this.updateNode(sql, values);
    if (sql.startsWith("INSERT INTO memory_node_versions")) return this.insertVersion(values);
    if (sql.startsWith("UPDATE memory_node_versions")) {
      return sql.includes("SET valid_to")
        ? this.closeVersion(values)
        : this.setVersionStatus(sql, values);
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM memory_node_versions")) return this.selectVersions(sql, values);
    if (sql.startsWith("SELECT DISTINCT ON (v.node_id)")) return this.selectVersions(sql, values);
    if (sql.startsWith("INSERT INTO memory_evidence")) return this.insertEvidence(values);
    if (sql.includes("FROM memory_evidence")) return this.selectEvidence(sql, values);
    if (sql.startsWith("INSERT INTO memory_conflicts")) return this.insertConflict(values);
    if (sql.includes("FROM memory_conflicts")) return this.selectConflicts(values);
    if (sql.startsWith("INSERT INTO memory_entity_aliases")) return this.insertAlias(values);
    if (sql.includes("FROM memory_entity_aliases")) return this.selectByAlias(values);
    if (sql.startsWith("INSERT INTO memory_entity_merges")) return this.insertMerge(values);
    if (sql.startsWith("UPDATE memory_entity_merges")) return this.rollbackMerge(values);
    if (sql.startsWith("INSERT INTO memory_backfill_state")) return this.claimBackfill(values);
    if (sql.startsWith("UPDATE memory_backfill_state")) return this.updateBackfill(values);
    if (sql.startsWith("SELECT") && sql.includes("FROM memory_edges")) return this.selectEdges(values);
    if (sql.startsWith("INSERT INTO memory_episodes")) return this.insertEpisode(values);
    if (sql.startsWith("UPDATE memory_episodes")) return this.updateEpisode(sql, values);
    if (sql.includes("FROM memory_episodes")) return this.selectEpisode(values);
    if (sql.startsWith("INSERT INTO memory_curator_runs")) return this.insertCuratorRun(values);
    if (sql.includes("FROM users WHERE telegram_id")) {
      return this.rowsOf("users").filter((row) => row.telegram_id === values[0]);
    }
    return [];
  }

  // ---- memory_nodes ---------------------------------------------------

  private selectNodes(sql: string, values: unknown[]): FakeRow[] {
    const rows = this.rowsOf("memory_nodes");
    if (sql.includes("id > $1")) {
      // Партия переноса: курсор по id, без арендатора — это системный путь.
      const after = Number(values[0]);
      const limit = Number(values[1]);
      return rows
        .filter((row) => Number(row.id) > after)
        .sort((left, right) => Number(left.id) - Number(right.id))
        .slice(0, limit);
    }
    const userId = values[0];
    let found = rows.filter((row) => row.user_id === userId);
    if (sql.includes("canonical_key = $3")) {
      found = found.filter((row) => row.node_type === values[1] && row.canonical_key === values[2]);
    } else if (sql.includes("AND id = $2")) {
      found = found.filter((row) => String(row.id) === String(values[1]));
    } else if (sql.includes("translate(lower(n.title") || sql.includes("translate(lower(title")) {
      const wanted = String(values[3] ?? values[2]);
      const exclude = sql.includes("n.id <> $3") ? String(values[2]) : null;
      found = found.filter((row) =>
        row.node_type === values[1]
        && ["active", "candidate"].includes(String(row.status))
        && String(row.id) !== exclude
        && normalize(String(row.title)) === wanted);
    } else if (sql.includes("websearch_to_tsquery")) {
      const wanted = String(values[3] ?? values[2]);
      const exclude = sql.includes("n.id <> $3") ? String(values[2]) : null;
      found = found.filter((row) =>
        row.node_type === values[1]
        && ["active", "candidate"].includes(String(row.status))
        && String(row.id) !== exclude
        && wanted.split(" ").some((word) =>
          word.length > 2 && `${row.title} ${row.text_content ?? ""}`.toLowerCase().includes(word)));
    } else if (sql.includes("status = ANY($2::text[])")) {
      const statuses = values[1] as string[];
      found = found.filter((row) => statuses.includes(String(row.status)) && row.fact_key != null);
      if (values[2]) found = found.filter((row) => row.node_type === values[2]);
      return found.slice(0, Number(values[3] ?? 100));
    }
    return found;
  }

  private insertNode(values: unknown[]): FakeRow[] {
    const table = this.table("memory_nodes");
    table.sequence += 1;
    const row: FakeRow = {
      id: String(table.sequence),
      user_id: values[0],
      node_type: values[1],
      canonical_key: values[2],
      title: values[3],
      text_content: values[4],
      content_json: JSON.parse(String(values[5])),
      status: values[6],
      confidence: values[7],
      sensitivity: values[8],
      source_type: values[9],
      source_id: values[10],
      source_quote: values[11],
      fact_key: values[12],
      version: 1,
      valid_from: values[13],
      valid_to: values[14],
      observed_at: values[15],
      event_at: values[16],
      entity_id: null,
      current_version_id: null,
      created_at: new Date(),
    };
    table.rows.push(row);
    return [{ id: row.id }];
  }

  private updateNode(sql: string, values: unknown[]): FakeRow[] {
    const row = this.rowsOf("memory_nodes").find(
      (candidate) => candidate.user_id === values[0] && String(candidate.id) === String(values[1]),
    );
    if (!row) return [];
    if (sql.includes("SET current_version_id = $3, confidence = $4")) {
      row.current_version_id = values[2];
      row.confidence = values[3];
    } else if (sql.includes("SET confidence = $3, observed_at")) {
      row.confidence = values[2];
      row.observed_at = row.observed_at ?? values[3];
    } else if (sql.includes("SET status = 'refuted'")) {
      row.status = "refuted";
      row.confidence = values[2];
      return [{ id: row.id, fact_key: row.fact_key, current_version_id: row.current_version_id }];
    } else if (sql.includes("SET entity_id = $3, status = 'superseded'")) {
      row.entity_id = values[2];
      row.status = "superseded";
    } else if (sql.includes("SET entity_id = $3, status = $4")) {
      row.entity_id = values[2];
      row.status = values[3];
    } else if (sql.includes("SET fact_key = COALESCE")) {
      row.fact_key = row.fact_key ?? values[2];
      row.current_version_id = row.current_version_id ?? values[3];
      row.observed_at = row.observed_at ?? values[4];
      row.valid_from = row.valid_from ?? values[5];
    } else if (sql.includes("SET title = $3")) {
      Object.assign(row, {
        title: values[2],
        text_content: values[3],
        content_json: JSON.parse(String(values[4])),
        status: values[5],
        confidence: values[6],
        sensitivity: values[7],
        fact_key: values[8],
        version: values[9],
        current_version_id: values[10],
        valid_from: values[11],
        valid_to: values[12],
        observed_at: values[13],
        event_at: values[14],
      });
    } else if (sql.includes("SET status = 'active'")) {
      if (!["candidate", "quarantined", "refuted"].includes(String(row.status))) return [];
      row.status = "active";
      return [{ id: row.id, current_version_id: row.current_version_id }];
    } else if (sql.includes("SET status = 'rejected'")) {
      if (!["candidate", "quarantined"].includes(String(row.status))) return [];
      row.status = "rejected";
    } else if (sql.includes("SET current_version_id = NULL")) {
      row.current_version_id = null;
    } else if (sql.includes("SET status = 'deleted'")) {
      Object.assign(row, {
        status: "deleted", text_content: null, content_json: {}, confidence: 0,
      });
    } else if (sql.includes("SET confidence = $3 WHERE")) {
      row.confidence = values[2];
    } else if (sql.includes("SET status = $3")) {
      row.status = values[2];
    }
    return [{ id: row.id }];
  }

  // ---- memory_node_versions -------------------------------------------

  private insertVersion(values: unknown[]): FakeRow[] {
    const table = this.table("memory_node_versions");
    const duplicate = table.rows.find((row) =>
      row.user_id === values[0]
      && String(row.node_id) === String(values[1])
      && Number(row.version) === Number(values[3]));
    // ON CONFLICT (user_id, node_id, version) DO NOTHING.
    if (duplicate) return [];
    table.sequence += 1;
    const isBackfill = values.length === 12;
    const row: FakeRow = isBackfill
      ? {
        id: String(table.sequence),
        user_id: values[0],
        node_id: values[1],
        fact_key: values[2],
        version: 1,
        supersedes_version_id: null,
        title: values[3],
        text_content: values[4],
        content_json: JSON.parse(String(values[5])),
        status: values[6],
        confidence: values[7],
        sensitivity: values[8],
        valid_from: values[9],
        valid_to: values[10],
        event_at: null,
        observed_at: values[11],
        recorded_at: values[11],
        change_reason: "backfill",
        actor_type: "system",
      }
      : {
        id: String(table.sequence),
        user_id: values[0],
        node_id: values[1],
        fact_key: values[2],
        version: values[3],
        supersedes_version_id: values[4],
        title: values[5],
        text_content: values[6],
        content_json: JSON.parse(String(values[7])),
        status: values[8],
        confidence: values[9],
        sensitivity: values[10],
        valid_from: values[11],
        valid_to: values[12],
        event_at: values[13],
        observed_at: values[14],
        recorded_at: new Date(),
        change_reason: values[15],
        actor_type: values[16],
      };
    table.rows.push(row);
    return [{ id: row.id }];
  }

  private setVersionStatus(sql: string, values: unknown[]): FakeRow[] {
    const status = sql.includes("'active'") ? "active" : "rejected";
    const rows = this.rowsOf("memory_node_versions").filter(
      (row) => row.user_id === values[0]
        && String(row.node_id) === String(values[1])
        && row.valid_to == null,
    );
    for (const row of rows) row.status = status;
    return rows;
  }

  private closeVersion(values: unknown[]): FakeRow[] {
    const row = this.rowsOf("memory_node_versions").find(
      (candidate) => candidate.user_id === values[0]
        && String(candidate.id) === String(values[1])
        && candidate.status !== "superseded",
    );
    if (!row) return [];
    row.valid_to = row.valid_to ?? values[2];
    row.status = "superseded";
    return [{ id: row.id }];
  }

  private selectVersions(sql: string, values: unknown[]): FakeRow[] {
    const userId = values[0];
    let rows = this.rowsOf("memory_node_versions").filter((row) => row.user_id === userId);

    if (sql.includes("AND node_id = $2 AND version = 1")) {
      return rows.filter((row) => String(row.node_id) === String(values[1]) && Number(row.version) === 1);
    }
    if (sql.includes("AND fact_key = $2")) {
      rows = rows.filter((row) => row.fact_key === values[1]);
    }
    if (sql.includes("valid_to IS NULL AND status = ANY($3::text[])")) {
      const statuses = values[2] as string[];
      return rows
        .filter((row) => row.valid_to == null && statuses.includes(String(row.status)))
        .sort((left, right) => Number(right.version) - Number(left.version))
        .slice(0, 1);
    }
    // Проверка состояния сущности стоит РАНЬШЕ разбора «факт на дату»:
    // её условие содержит ту же подстроку `valid_from <= $3`, и обратный
    // порядок молча уводил бы запрос не в ту ветку.
    if (sql.includes("v.valid_from <= $3")) {
      const entityId = String(values[1]);
      const asOf = TIME(values[2]);
      const excluded = values[3] as string[];
      const nodes = this.rowsOf("memory_nodes").filter(
        (node) => node.user_id === userId
          && (String(node.entity_id) === entityId || String(node.id) === entityId),
      );
      const nodeIds = new Set(nodes.map((node) => String(node.id)));
      const live = rows.filter((row) => nodeIds.has(String(row.node_id))
        && TIME(row.valid_from) <= asOf
        && (row.valid_to == null || TIME(row.valid_to) > asOf)
        && !excluded.includes(String(row.status)));
      const perNode = new Map<string, FakeRow>();
      for (const row of live.sort((left, right) => Number(right.version) - Number(left.version))) {
        if (!perNode.has(String(row.node_id))) perNode.set(String(row.node_id), row);
      }
      return [...perNode.values()].slice(0, Number(values[4]));
    }
    if (sql.includes("valid_from <= $3")) {
      const asOf = TIME(values[2]);
      const excluded = values[3] as string[];
      return rows
        .filter((row) => TIME(row.valid_from) <= asOf
          && (row.valid_to == null || TIME(row.valid_to) > asOf)
          && !excluded.includes(String(row.status)))
        .sort((left, right) => Number(right.version) - Number(left.version))
        .slice(0, 1);
    }
    if (sql.includes("recorded_at >= $2")) {
      const from = TIME(values[1]);
      const to = TIME(values[2]);
      return rows
        .filter((row) => TIME(row.recorded_at) >= from && TIME(row.recorded_at) < to)
        .sort((left, right) => TIME(left.recorded_at) - TIME(right.recorded_at) || Number(left.id) - Number(right.id))
        .slice(0, Number(values[3]));
    }
    // Полная история.
    return rows
      .sort((left, right) => Number(left.version) - Number(right.version))
      .slice(0, Number(values[2] ?? 100));
  }

  // ---- memory_evidence -------------------------------------------------

  private insertEvidence(values: unknown[]): FakeRow[] {
    const table = this.table("memory_evidence");
    const duplicate = table.rows.find((row) =>
      row.user_id === values[0]
      && String(row.node_id ?? "") === String(values[2] ?? "")
      && String(row.edge_id ?? "") === String(values[3] ?? "")
      && row.content_hash === values[13]);
    if (duplicate) return [];
    table.sequence += 1;
    table.rows.push({
      id: String(table.sequence),
      user_id: values[0],
      subject_kind: values[1],
      node_id: values[2],
      edge_id: values[3],
      version_id: values[4],
      source_type: values[5],
      source_id: values[6],
      message_id: values[7],
      episode_id: values[8],
      source_at: values[9],
      event_at: values[10],
      support: values[11],
      confidence: values[12],
      content_hash: values[13],
      created_at: new Date(),
    });
    return [{ id: String(table.sequence) }];
  }

  private selectEvidence(sql: string, values: unknown[]): FakeRow[] {
    const rows = this.rowsOf("memory_evidence").filter(
      (row) => row.user_id === values[0]
        && row.subject_kind === "node"
        && String(row.node_id) === String(values[1]),
    );
    return sql.includes("LIMIT $3") ? rows.slice(0, Number(values[2])) : rows;
  }

  // ---- memory_conflicts -------------------------------------------------

  private insertConflict(values: unknown[]): FakeRow[] {
    const table = this.table("memory_conflicts");
    table.sequence += 1;
    table.rows.push({
      id: String(table.sequence),
      user_id: values[0],
      fact_key: values[1],
      node_id: values[2],
      refuted_version_id: values[3],
      winning_version_id: values[4],
      kind: values[5],
      significance: values[6],
      status: values[7],
      detail: JSON.parse(String(values[8])),
      created_at: new Date(),
    });
    return [{ id: String(table.sequence) }];
  }

  private selectConflicts(values: unknown[]): FakeRow[] {
    return this.rowsOf("memory_conflicts")
      .filter((row) => row.user_id === values[0] && ["open", "awaiting_user"].includes(String(row.status)))
      .slice(0, Number(values[1] ?? 50));
  }

  // ---- сущности ---------------------------------------------------------

  private insertAlias(values: unknown[]): FakeRow[] {
    const table = this.table("memory_entity_aliases");
    const duplicate = table.rows.find((row) =>
      row.user_id === values[0]
      && String(row.node_id) === String(values[1])
      && row.normalized_alias === values[4]);
    if (duplicate) return [];
    table.sequence += 1;
    table.rows.push({
      id: String(table.sequence),
      user_id: values[0],
      node_id: values[1],
      node_type: values[2],
      alias: values[3],
      normalized_alias: values[4],
      alias_kind: values[5],
    });
    return [{ id: String(table.sequence) }];
  }

  private selectByAlias(values: unknown[]): FakeRow[] {
    const aliases = this.rowsOf("memory_entity_aliases").filter(
      (row) => row.user_id === values[0]
        && row.node_type === values[1]
        && row.normalized_alias === values[3]
        && String(row.node_id) !== String(values[2]),
    );
    const nodes = this.rowsOf("memory_nodes");
    return aliases
      .map((alias) => nodes.find((node) => String(node.id) === String(alias.node_id) && node.user_id === values[0]))
      .filter((node): node is FakeRow => Boolean(node))
      .map((node) => ({
        id: node.id,
        title: node.title,
        node_type: node.node_type,
        content_json: node.content_json,
      }));
  }

  private insertMerge(values: unknown[]): FakeRow[] {
    const table = this.table("memory_entity_merges");
    table.sequence += 1;
    table.rows.push({
      id: String(table.sequence),
      user_id: values[0],
      source_node_id: values[1],
      target_node_id: values[2],
      decision: "merged",
      score: values[3],
      reason: values[4],
      actor_type: values[5],
      snapshot: JSON.parse(String(values[6])),
      rolled_back_at: null,
    });
    return [{ id: String(table.sequence) }];
  }

  private rollbackMerge(values: unknown[]): FakeRow[] {
    const row = this.rowsOf("memory_entity_merges").find(
      (candidate) => candidate.user_id === values[0]
        && String(candidate.id) === String(values[1])
        && candidate.rolled_back_at === null,
    );
    if (!row) return [];
    row.rolled_back_at = new Date();
    return [{ source_node_id: row.source_node_id, snapshot: row.snapshot }];
  }

  // ---- перенос -----------------------------------------------------------

  private claimBackfill(values: unknown[]): FakeRow[] {
    const table = this.table("memory_backfill_state");
    let row = table.rows.find((candidate) => candidate.backfill_key === values[0]);
    if (!row) {
      row = { backfill_key: values[0], last_node_id: "0", processed_nodes: "0", status: "running" };
      table.rows.push(row);
    }
    row.status = "running";
    return [row];
  }

  private updateBackfill(values: unknown[]): FakeRow[] {
    const row = this.rowsOf("memory_backfill_state").find(
      (candidate) => candidate.backfill_key === values[0],
    );
    if (!row) return [];
    row.last_node_id = String(values[1]);
    row.processed_nodes = String(Number(row.processed_nodes) + Number(values[2]));
    row.status = values[3];
    return [row];
  }

  // ---- эпизоды и прогоны Curator ---------------------------------------

  private insertEpisode(values: unknown[]): FakeRow[] {
    const table = this.table("memory_episodes");
    const duplicate = table.rows.find(
      (row) => row.user_id === values[0] && row.episode_key === values[2],
    );
    // ON CONFLICT (user_id, episode_key) DO NOTHING.
    if (duplicate) return [];
    table.sequence += 1;
    const row: FakeRow = {
      id: String(table.sequence),
      user_id: values[0],
      conversation_id: values[1],
      episode_key: values[2],
      purpose: values[3],
      status: "closed",
      boundary_reason: values[4],
      summary: values[5],
      message_ids: values[6],
      privacy_mode: values[7],
      message_count: values[8],
      started_at: values[9],
      ended_at: values[10],
    };
    table.rows.push(row);
    return [row];
  }

  private updateEpisode(sql: string, values: unknown[]): FakeRow[] {
    const row = this.rowsOf("memory_episodes").find(
      (candidate) => candidate.user_id === values[0] && String(candidate.id) === String(values[1]),
    );
    if (!row) return [];
    if (sql.includes("SET status = 'curating'")) {
      if (row.status !== "closed") return [];
      row.status = "curating";
      return [row];
    }
    row.status = values[2];
    return [row];
  }

  private selectEpisode(values: unknown[]): FakeRow[] {
    return this.rowsOf("memory_episodes").filter(
      (row) => row.user_id === values[0] && String(row.id) === String(values[1]),
    );
  }

  private insertCuratorRun(values: unknown[]): FakeRow[] {
    const table = this.table("memory_curator_runs");
    const duplicate = table.rows.find(
      (row) => row.user_id === values[0] && row.run_id === values[2],
    );
    if (duplicate) return [];
    table.sequence += 1;
    table.rows.push({
      id: String(table.sequence),
      user_id: values[0],
      episode_id: values[1],
      run_id: values[2],
      mode: values[3],
      status: values[4],
      proposal: JSON.parse(String(values[5])),
      applied: JSON.parse(String(values[6])),
      error_code: values[7],
    });
    return [];
  }

  /**
   * Удаление производных. Условия здесь простые по устройству: каждое
   * из них ограничено владельцем и одним узлом — ровно то, что делает
   * полная чистка факта.
   */
  private deleteRows(sql: string, values: unknown[]): FakeRow[] {
    const match = /DELETE FROM ([a-z_]+)/.exec(sql);
    if (!match) return [];
    const table = this.table(match[1]!);
    const nodeId = String(values[1]);
    const before = table.rows.length;
    table.rows = table.rows.filter((row) => {
      if (row.user_id !== values[0]) return true;
      if (sql.includes("source_node_id = $2 OR target_node_id = $2")) {
        return String(row.source_node_id) !== nodeId && String(row.target_node_id) !== nodeId;
      }
      if (sql.includes("from_node_id = $2 OR to_node_id = $2")) {
        return String(row.from_node_id) !== nodeId && String(row.to_node_id) !== nodeId;
      }
      return String(row.node_id) !== nodeId;
    });
    return new Array(before - table.rows.length).fill({}) as FakeRow[];
  }

  private selectEdges(values: unknown[]): FakeRow[] {
    const from = TIME(values[4]);
    const to = values[5] == null ? Number.POSITIVE_INFINITY : TIME(values[5]);
    return this.rowsOf("memory_edges").filter((row) =>
      row.user_id === values[0]
      && String(row.from_node_id) === String(values[1])
      && row.relation_type === values[2]
      && String(row.to_node_id) === String(values[3])
      && ["active", "candidate"].includes(String(row.status))
      && (row.valid_from == null || TIME(row.valid_from) < to)
      && (row.valid_to == null || TIME(row.valid_to) > from));
  }
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
