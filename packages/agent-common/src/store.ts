import fs from 'node:fs';
import path from 'node:path';
import type { Finding } from '@ragent/agent-protocol';

/**
 * Durable storage for findings, incidents and events.
 *
 * Everything in this framework lived in memory until now, so a restart was
 * total amnesia: an operator who restarted an agent lost the incident they were
 * investigating, and there was no way to answer "has this happened before?" -
 * which is the first question anyone asks about a recurring fault.
 *
 * SQLite rather than a service, because the alternative is asking someone to
 * run Postgres to monitor a router. One file, no daemon, and `better-sqlite3`
 * ships prebuilt binaries so `npm install` needs no compiler.
 *
 * Synchronous by design. These writes are small and infrequent - a handful per
 * poll cycle - and a synchronous call that cannot interleave is far easier to
 * reason about than an async one inside a polling loop that may overlap.
 */

export interface StoreOptions {
  /** File path, or ':memory:' for an ephemeral store (tests). */
  file: string;
  /** Rows kept per table before the oldest are pruned. */
  maxRows?: number;
}

export interface StoredIncident {
  id: string;
  entity: string;
  severity: string;
  rootCauseKind: string;
  rootCauseTitle: string;
  findingCount: number;
  agents: string[];
  confidence: number;
  simulated: boolean;
  startedAt: string;
  lastActivityAt: string;
  narrative?: string | null;
}

interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
  pragma(sql: string): unknown;
}

export class Store {
  private db: SqliteLike | null = null;
  private readonly maxRows: number;
  readonly file: string;
  /** False when the driver could not be loaded; every method becomes a no-op. */
  readonly available: boolean;

  constructor({ file, maxRows = 5000 }: StoreOptions) {
    this.file = file;
    this.maxRows = maxRows;

    let Database: new (f: string) => SqliteLike;
    try {
      // Required lazily so a missing native binary degrades to no persistence
      // rather than preventing the agent from starting. Monitoring that runs
      // without history beats monitoring that will not run.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Database = require('better-sqlite3');
    } catch {
      this.available = false;
      return;
    }

    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }

    this.db = new Database(file);
    // WAL: a reader (the API serving history) never blocks the writer (the
    // poll loop recording a finding).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.available = true;
  }

  private migrate(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        id            TEXT PRIMARY KEY,
        dedupe_key    TEXT NOT NULL,
        agent         TEXT NOT NULL,
        kind          TEXT NOT NULL,
        severity      TEXT NOT NULL,
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        title         TEXT NOT NULL,
        detail        TEXT,
        evidence      TEXT NOT NULL,
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL,
        count         INTEGER NOT NULL,
        simulated     INTEGER NOT NULL,
        resolved_at   TEXT,
        resolve_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_findings_dedupe ON findings(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_findings_last_seen ON findings(last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_entity ON findings(entity_id);

      CREATE TABLE IF NOT EXISTS incidents (
        id               TEXT PRIMARY KEY,
        entity           TEXT NOT NULL,
        severity         TEXT NOT NULL,
        root_cause_kind  TEXT NOT NULL,
        root_cause_title TEXT NOT NULL,
        finding_count    INTEGER NOT NULL,
        agents           TEXT NOT NULL,
        confidence       REAL NOT NULL,
        simulated        INTEGER NOT NULL,
        started_at       TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        narrative        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents(started_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT NOT NULL,
        agent    TEXT NOT NULL,
        kind     TEXT NOT NULL,
        entity   TEXT,
        detail   TEXT,
        payload  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
    `);
  }

  /** Inserts or updates a finding, keyed on its dedupe identity. */
  saveFinding(f: Finding): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO findings (id, dedupe_key, agent, kind, severity, entity_type, entity_id,
                               title, detail, evidence, first_seen, last_seen, count, simulated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen = excluded.last_seen,
           count     = excluded.count,
           severity  = excluded.severity,
           evidence  = excluded.evidence`,
      )
      .run(
        f.id,
        f.dedupeKey,
        f.agent,
        f.kind,
        f.severity,
        f.entity.type,
        f.entity.id,
        f.title,
        f.detail ?? null,
        JSON.stringify(f.evidence),
        f.firstSeen,
        f.lastSeen,
        f.count,
        f.simulated ? 1 : 0,
      );
    this.prune('findings', 'last_seen');
  }

  markFindingResolved(dedupeKey: string, reason: string, at = new Date().toISOString()): void {
    if (!this.db) return;
    this.db
      .prepare(
        `UPDATE findings SET resolved_at = ?, resolve_reason = ?
         WHERE dedupe_key = ? AND resolved_at IS NULL`,
      )
      .run(at, reason, dedupeKey);
  }

  saveIncident(i: StoredIncident): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO incidents (id, entity, severity, root_cause_kind, root_cause_title,
                                finding_count, agents, confidence, simulated,
                                started_at, last_activity_at, narrative)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           last_activity_at = excluded.last_activity_at,
           finding_count    = excluded.finding_count,
           severity         = excluded.severity,
           narrative        = COALESCE(excluded.narrative, incidents.narrative)`,
      )
      .run(
        i.id,
        i.entity,
        i.severity,
        i.rootCauseKind,
        i.rootCauseTitle,
        i.findingCount,
        JSON.stringify(i.agents),
        i.confidence,
        i.simulated ? 1 : 0,
        i.startedAt,
        i.lastActivityAt,
        i.narrative ?? null,
      );
    this.prune('incidents', 'started_at');
  }

  recordEvent(
    agent: string,
    kind: string,
    detail?: string,
    payload?: unknown,
    entity?: string,
  ): void {
    if (!this.db) return;
    this.db
      .prepare('INSERT INTO events (at, agent, kind, entity, detail, payload) VALUES (?,?,?,?,?,?)')
      .run(
        new Date().toISOString(),
        agent,
        kind,
        entity ?? null,
        detail ?? null,
        payload === undefined ? null : JSON.stringify(payload),
      );
    this.prune('events', 'at');
  }

  /** Recent findings, newest first. */
  recentFindings(limit = 100): Record<string, unknown>[] {
    if (!this.db) return [];
    return this.db
      .prepare('SELECT * FROM findings ORDER BY last_seen DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
  }

  recentIncidents(limit = 50): Record<string, unknown>[] {
    if (!this.db) return [];
    return this.db
      .prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
  }

  recentEvents(limit = 200): Record<string, unknown>[] {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT ?').all(limit) as Record<
      string,
      unknown
    >[];
  }

  /**
   * How often this exact condition has occurred before.
   *
   * The question an operator actually asks when a fault appears - "is this new,
   * or does it happen every Tuesday?" - and one the framework could not answer
   * at all while everything lived in memory.
   */
  historyFor(dedupeKey: string): {
    occurrences: number;
    firstEver: string | null;
    lastEver: string | null;
  } {
    if (!this.db) return { occurrences: 0, firstEver: null, lastEver: null };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(first_seen) AS first_ever, MAX(last_seen) AS last_ever
         FROM findings WHERE dedupe_key = ?`,
      )
      .get(dedupeKey) as { n: number; first_ever: string | null; last_ever: string | null };
    return {
      occurrences: row?.n ?? 0,
      firstEver: row?.first_ever ?? null,
      lastEver: row?.last_ever ?? null,
    };
  }

  /** Keeps each table bounded. A monitoring database must not grow forever. */
  private prune(table: string, orderColumn: string): void {
    if (!this.db) return;
    this.db
      .prepare(
        `DELETE FROM ${table} WHERE rowid NOT IN (
           SELECT rowid FROM ${table} ORDER BY ${orderColumn} DESC LIMIT ?
         )`,
      )
      .run(this.maxRows);
  }

  stats(): {
    available: boolean;
    file: string;
    findings: number;
    incidents: number;
    events: number;
  } {
    if (!this.db)
      return { available: false, file: this.file, findings: 0, incidents: 0, events: 0 };
    const count = (t: string) =>
      (this.db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      available: true,
      file: this.file,
      findings: count('findings'),
      incidents: count('incidents'),
      events: count('events'),
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/**
 * Opens the store for an agent, or returns a no-op one.
 *
 * Persistence is a convenience, not a dependency: an agent whose database
 * cannot be opened should keep monitoring, not refuse to start.
 */
export function openStore(
  agentName: string,
  dir?: string,
  logger?: { warn(m: string): void },
): Store {
  const base = dir ?? process.env.RAGENT_DATA_DIR ?? path.join(process.cwd(), 'data');
  try {
    const store = new Store({ file: path.join(base, `${agentName}.db`) });
    if (!store.available) {
      logger?.warn(
        'better-sqlite3 is unavailable; running without persistence (history will not survive a restart)',
      );
    }
    return store;
  } catch (error) {
    logger?.warn(
      `Could not open the datastore: ${(error as Error).message}. Running without persistence.`,
    );
    return new Store({ file: ':memory:' });
  }
}
