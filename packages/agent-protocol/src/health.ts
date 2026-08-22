import { z } from 'zod';

/**
 * Three states, because two is not enough to describe this framework honestly.
 *
 * The distinction that matters: an agent whose monitored device is unreachable
 * is `degraded`, not `unhealthy`. The agent is doing its job correctly by
 * reporting that it cannot reach the device. Conflating the two is why agent2
 * historically reported `healthy: false` on a perfectly healthy process, which
 * then drove the AI layer to burn a model call every single poll cycle.
 */
export const HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy'] as const;
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthCheckSchema = z.object({
  /** Short identifier, e.g. "snmp_primary" or "config_loaded". */
  name: z.string().min(1),
  status: HealthStatusSchema,
  /** One line explaining a non-healthy status. Omit when healthy. */
  message: z.string().optional(),
  /** How long the check took, when it performs I/O. */
  durationMs: z.number().nonnegative().optional(),
  /** True when this check inspected a simulated path rather than a real one. */
  simulated: z.boolean().default(false),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const HealthReportSchema = z.object({
  agent: z.string().min(1),

  /**
   * Whether the *process* is functioning. Device reachability lives in
   * `checks` and drives `degraded`, never `unhealthy`.
   */
  status: HealthStatusSchema,

  timestamp: z.string().datetime(),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string().optional(),
  checks: z.array(HealthCheckSchema).default([]),

  /** True when any contributing check ran against a simulated path. */
  simulated: z.boolean().default(false),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

/**
 * Rolls individual checks into one status.
 *
 * Any unhealthy check makes the agent unhealthy; otherwise any degraded check
 * makes it degraded. An agent with no checks is healthy — it is up and
 * answering, which is all a bare liveness probe claims.
 */
export function rollUpStatus(checks: readonly HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === 'unhealthy')) return 'unhealthy';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'healthy';
}

export function buildHealthReport(params: {
  agent: string;
  checks?: readonly HealthCheck[];
  version?: string;
  uptimeSeconds?: number;
  now?: Date;
}): HealthReport {
  const checks = params.checks ?? [];
  return HealthReportSchema.parse({
    agent: params.agent,
    status: rollUpStatus(checks),
    timestamp: (params.now ?? new Date()).toISOString(),
    uptimeSeconds: params.uptimeSeconds ?? process.uptime(),
    version: params.version,
    checks,
    simulated: checks.some((c) => c.simulated),
  });
}

/**
 * HTTP status for a health response.
 *
 * `degraded` returns 200 deliberately. Orchestrators and container runtimes
 * restart on a failing health check, and restarting an agent because the
 * router it watches went down would turn one outage into two.
 */
export function healthHttpStatus(status: HealthStatus): 200 | 503 {
  return status === 'unhealthy' ? 503 : 200;
}
