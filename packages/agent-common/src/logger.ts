import winston from 'winston';

/**
 * Keys whose values must never reach a log sink, matched case-insensitively as
 * substrings so `snmp_community`, `SMTP_PASS` and `apiKey` are all caught.
 *
 * This matters more than it looks: agents log config objects on startup and
 * error payloads on failure, and this framework's config contains SNMP
 * community strings, router credentials and an LLM API key.
 */
const SECRET_KEY_PATTERNS = [
  // 'pass' rather than 'password', so SMTP_PASS and pass/passwd variants are
  // all caught. It over-matches words like "passive", which is the correct
  // trade: an over-redacted log line costs nothing, a leaked credential does.
  'pass', 'secret', 'token', 'apikey', 'api_key',
  'community', 'credential', 'authorization', 'auth', 'private', 'key',
];

const REDACTED = '[redacted]';

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Recursively redacts secret-looking values. Handles cycles, because a logged
 * Express request or error can easily contain one and a stack overflow inside
 * the logger would take the process down.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

/** Redacts bearer tokens and key-like strings that appear inside free text. */
export function redactText(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
}

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') info.message = redactText(info.message);
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    if (isSecretKey(key)) {
      (info as Record<string, unknown>)[key] = REDACTED;
    } else {
      (info as Record<string, unknown>)[key] = redact((info as Record<string, unknown>)[key]);
    }
  }
  return info;
});

export interface LoggerOptions {
  /** Agent name, attached to every record. */
  agent: string;
  level?: string;
  /**
   * `json` for aggregation, `pretty` for a terminal. Defaults to pretty when
   * stdout is a TTY, json otherwise — which is the right default in both a
   * dev shell and a container.
   */
  format?: 'json' | 'pretty';
  /** Optional file destination. Omit to log to stdout only. */
  logDir?: string;
}

export type AgentLogger = winston.Logger;

export function createLogger(opts: LoggerOptions): AgentLogger {
  const useJson = opts.format
    ? opts.format === 'json'
    : !process.stdout.isTTY;

  const pretty = winston.format.printf((info) => {
    const { timestamp, level, message, agent, correlationId, ...rest } = info as Record<string, unknown>;
    const cid = correlationId ? ` [${String(correlationId)}]` : '';
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${String(timestamp)} ${String(level).toUpperCase().padEnd(5)} [${String(agent)}]${cid} ${String(message)}${extra}`;
  });

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: useJson
        ? winston.format.combine(redactFormat(), winston.format.json())
        : winston.format.combine(redactFormat(), winston.format.colorize({ level: true }), pretty),
    }),
  ];

  if (opts.logDir) {
    transports.push(
      new winston.transports.File({
        filename: `${opts.logDir}/${opts.agent}.log`,
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        format: winston.format.combine(redactFormat(), winston.format.json()),
      }),
      new winston.transports.File({
        filename: `${opts.logDir}/${opts.agent}-error.log`,
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        format: winston.format.combine(redactFormat(), winston.format.json()),
      }),
    );
  }

  return winston.createLogger({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    defaultMeta: { agent: opts.agent },
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
    ),
    transports,
  });
}
