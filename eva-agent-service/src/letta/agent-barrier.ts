/**
 * Барьер обслуживания агента.
 *
 * Канонический контекст меняется вне хода: system prompt через
 * `agents.update`, персона — записью в MemFS с коммитом. Ход, начавшийся
 * посреди такой правки, читает половину нового состояния: prompt уже
 * новый, файл ещё старый — или наоборот. Снимок пула сессий этого не
 * закрывает: сессия открывается заново на любом ходе, и между «в пуле
 * никого» и «ход пошёл» проходит ровно то окно, в котором идёт правка.
 *
 * Поэтому барьер ведётся по агенту, а не по conversation и не по пулу:
 *
 * - идущий ход договаривает, его никто не прерывает;
 * - пока обслуживание идёт, новый ход этого агента ждёт;
 * - другой агент не ждёт ничего.
 *
 * Барьер общий для всех входов — Telegram, Mini App, административного и
 * фонового: он живёт в `LettaService`, через который проходит каждый ход.
 */

interface BarrierState {
  /** Сколько ходов по этому ключу выполняется прямо сейчас. */
  turns: number;
  /** Пока обещание не выполнено, новый ход по этому ключу ждёт. */
  gate: Promise<void> | null;
  /** Тех, кто ждёт освобождения ходов, будим по факту, а не опросом. */
  drainWaiters: Array<() => void>;
}

export type MaintenanceOutcome<T> =
  | { status: "done"; value: T }
  /**
   * Ход не отпустил агента в отведённое окно. Правка не начиналась:
   * половина применённого хуже отложенного.
   */
  | { status: "busy" };

const agentKey = (agentId: string): string => `agent:${agentId}`;
const conversationKey = (conversationId: string): string => `conversation:${conversationId}`;

export class AgentMaintenanceBarrier {
  private readonly states = new Map<string, BarrierState>();
  /**
   * Кому принадлежит conversation. Ход приходит с conversation, а
   * обслуживание — с агентом; без связки барьер защищал бы не то.
   */
  private readonly conversationAgents = new Map<string, string>();

  /**
   * Запомнить владельца conversation.
   *
   * Связка появляется из init-сообщения сессии и из административных
   * операций — то есть из фактов SDK, а не из догадки о ключе.
   */
  bind(conversationId: string, agentId: string): void {
    if (!conversationId || !agentId) return;
    this.conversationAgents.set(conversationId, agentId);
  }

  agentFor(conversationId: string): string | undefined {
    return this.conversationAgents.get(conversationId);
  }

  /** Идёт ли правка канонического контекста этого агента прямо сейчас. */
  isMaintaining(agentId: string): boolean {
    return this.states.get(agentKey(agentId))?.gate != null;
  }

  activeTurns(agentId: string): number {
    let total = 0;
    for (const key of this.keysFor(agentId)) total += this.states.get(key)?.turns ?? 0;
    return total;
  }

  /**
   * Занять место под ход.
   *
   * Пока агента обслуживают, вызов ждёт: это и есть graceful-часть
   * барьера. Неизвестный агент считается по самой conversation — место
   * занимается всё равно, а `bind()` присоединяет её к агенту, как
   * только SDK его назвал.
   */
  async enterTurn(conversationId: string): Promise<() => void> {
    const key = this.resolveKey(conversationId);
    // Обслуживание могло начаться, пока мы ждали предыдущее: ждём в
    // цикле, а не один раз.
    for (;;) {
      const gate = this.states.get(key)?.gate;
      if (!gate) break;
      await gate;
    }
    const state = this.state(key);
    state.turns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.turns = Math.max(0, state.turns - 1);
      if (state.turns === 0) {
        for (const wake of state.drainWaiters.splice(0)) wake();
        this.forget(key, state);
      }
    };
  }

  /**
   * Выполнить правку канонического контекста агента.
   *
   * Сначала закрывается вход: новый ход этого агента ждёт. Затем ждём,
   * пока идущие ходы договорят, — но не дольше `drainTimeoutMs`. Не
   * успели: вход открывается обратно и правка не начинается вовсе.
   * Вызывающий получает `busy` и вправе отложить её на потом, ничего не
   * перетирая.
   */
  async runMaintenance<T>(
    agentId: string,
    work: () => Promise<T>,
    options: { drainTimeoutMs: number; conversationIds?: readonly string[] },
  ): Promise<MaintenanceOutcome<T>> {
    for (const conversationId of options.conversationIds ?? []) {
      this.bind(conversationId, agentId);
    }
    let keys = this.keysFor(agentId);
    // Второе обслуживание того же агента ждёт первое: одновременная
    // запись в тот же MemFS — тот же race, только между правками.
    for (;;) {
      const busy = keys
        .map((key) => this.states.get(key)?.gate)
        .find((gate): gate is Promise<void> => gate != null);
      if (!busy) break;
      await busy;
      // Пока ждали, у агента могла появиться новая conversation.
      keys = this.keysFor(agentId);
    }

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const gated = keys.map((key) => {
      const state = this.state(key);
      state.gate = gate;
      return { key, state };
    });
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const { key, state } of gated) {
        state.gate = null;
        this.forget(key, state);
      }
      openGate();
    };

    try {
      if (!await this.drain(gated.map(({ state }) => state), options.drainTimeoutMs)) {
        return { status: "busy" };
      }
      return { status: "done", value: await work() };
    } finally {
      release();
    }
  }

  /** Ключи, которые обслуживание обязано закрыть: агент и его conversations. */
  private keysFor(agentId: string): string[] {
    const keys = [agentKey(agentId)];
    for (const [conversationId, owner] of this.conversationAgents) {
      if (owner === agentId) keys.push(conversationKey(conversationId));
    }
    return keys;
  }

  private resolveKey(conversationId: string): string {
    const owner = this.conversationAgents.get(conversationId);
    return owner ? agentKey(owner) : conversationKey(conversationId);
  }

  private async drain(states: readonly BarrierState[], timeoutMs: number): Promise<boolean> {
    const pending = (): BarrierState | undefined => states.find((state) => state.turns > 0);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const state = pending();
      if (!state) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        state.drainWaiters.push(finish);
        const timer = setTimeout(finish, remaining);
        timer.unref?.();
      });
    }
  }

  private state(key: string): BarrierState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created: BarrierState = { turns: 0, gate: null, drainWaiters: [] };
    this.states.set(key, created);
    return created;
  }

  /** Простаивающая запись не остаётся в памяти: агентов больше, чем ходов. */
  private forget(key: string, state: BarrierState): void {
    if (state.turns === 0 && !state.gate && state.drainWaiters.length === 0) {
      this.states.delete(key);
    }
  }
}
