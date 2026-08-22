import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Turns a Zod failure into something an operator can act on.
 *
 * The original agents crashed on a missing config key with
 * `TypeError: Cannot read properties of undefined (reading 'host')` and a stack
 * trace pointing into library code — which tells you nothing about which key,
 * in which file, is wrong.
 */
function explain(error: z.ZodError, file: string): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      return `  ${where}  ->  required, but missing`;
    }
    return `  ${where}  ->  ${issue.message}`;
  });
  return `Invalid configuration in ${file}:\n${lines.join('\n')}`;
}

export interface LoadConfigOptions<T> {
  /** Absolute path to the YAML file. Always resolve with __dirname, never cwd. */
  file: string;
  schema: z.ZodType<T>;
  /**
   * Applied after parsing the file and before validation, so an env override
   * can satisfy a required field the file leaves out.
   */
  envOverrides?: (raw: Record<string, unknown>, env: NodeJS.ProcessEnv) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Reads, env-overrides, and validates a YAML config in one step.
 *
 * Throws `ConfigError` with a readable message. Callers should let it reach
 * the top and exit non-zero: a process running on invalid config is worse than
 * one that refuses to start.
 */
export function loadConfig<T>(opts: LoadConfigOptions<T>): T {
  const { file, schema } = opts;
  const env = opts.env ?? process.env;

  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `Configuration file not found: ${file}\n` +
        `  Expected it at that exact path. If you copied an example file, ` +
        `check the name matches (e.g. config.yml, not config.yml.example).`,
      file,
    );
  }

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not parse YAML in ${file}: ${(err as Error).message}`, file);
  }

  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${file} must contain a YAML mapping at the top level`, file);
  }

  const obj = raw as Record<string, unknown>;
  opts.envOverrides?.(obj, env);

  const result = schema.safeParse(obj);
  if (!result.success) throw new ConfigError(explain(result.error, file), file);
  return result.data;
}

/** Sets a nested value by dotted path, creating intermediate objects. */
export function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

/**
 * Applies `ENV_VAR -> config.path` overrides, coercing numbers and booleans.
 *
 * YAML holds typed values but the environment only has strings, so `PORT=9090`
 * has to become the number 9090 or schema validation rejects it.
 */
export function applyEnvMap(
  target: Record<string, unknown>,
  map: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [envVar, dotted] of Object.entries(map)) {
    const raw = env[envVar];
    if (raw === undefined || raw === '') continue;

    let value: unknown = raw;
    if (/^-?\d+$/.test(raw)) value = Number.parseInt(raw, 10);
    else if (/^-?\d*\.\d+$/.test(raw)) value = Number.parseFloat(raw);
    else if (raw === 'true') value = true;
    else if (raw === 'false') value = false;

    setPath(target, dotted, value);
  }
}

/** Resolves a path relative to a module's directory. Never relative to cwd. */
export function configPath(moduleDir: string, ...segments: string[]): string {
  return path.resolve(moduleDir, ...segments);
}

/**
 * Server settings every agent shares. Individual agents extend this rather
 * than redefining host/port/auth semantics five different ways.
 */
export const ServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  /**
   * Loopback by default. Every listener in this framework exposes operational
   * detail, and several expose control actions, so binding all interfaces has
   * to be a deliberate act rather than the default.
   */
  host: z.string().default('127.0.0.1'),
  health_path: z.string().startsWith('/').default('/health'),
  metrics_path: z.string().startsWith('/').default('/metrics'),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
