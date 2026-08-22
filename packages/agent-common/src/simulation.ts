/**
 * Registry of code paths that produce simulated rather than measured results.
 *
 * The framework contains functions that return plausible-looking data without
 * touching a device: a failover that sleeps and reports success, a config
 * validator that reads a generated placeholder, compliance checks that return
 * "compliant" unconditionally. Each was honestly commented in the source and
 * completely invisible at runtime - so a dashboard, a report, or the AI layer
 * would present the output as measured fact.
 *
 * For a monitoring and compliance tool that is the worst failure mode there is:
 * not being wrong, but being confidently wrong in a way nobody can see. This
 * module makes it visible in four places at once - the logs, the metrics, the
 * health endpoint, and the API response itself.
 *
 * The intent is that these registrations disappear one by one as real device
 * integrations land, and the registry is empty at 1.0-with-hardware.
 */

export interface SimulatedPath {
  /** Stable id, e.g. "agent2.executeFailover". */
  id: string;
  /** What it pretends to do. */
  what: string;
  /** What would be needed to make it real. */
  needs: string;
  /** Times this path has been taken since start. */
  invocations: number;
  firstUsedAt: string | null;
}

const registry = new Map<string, SimulatedPath>();
const warned = new Set<string>();

export interface SimulationLogger {
  warn(msg: string, meta?: unknown): void;
}

/**
 * Declares a simulated path at module load, before it is ever called.
 *
 * Registering up front means `/health` can advertise what is simulated even if
 * the path is never taken, so an operator learns what they are not getting
 * without having to trigger it first.
 */
export function declareSimulated(id: string, what: string, needs: string): void {
  if (!registry.has(id)) {
    registry.set(id, { id, what, needs, invocations: 0, firstUsedAt: null });
  }
}

/**
 * Records that a simulated path just ran. Warns loudly the first time.
 *
 * Returns a marker to spread into the result, so the response carries the flag
 * to whatever consumes it:
 *
 *     return { ...markSimulated('agent2.executeFailover', log), success: true };
 */
export function markSimulated(
  id: string,
  logger?: SimulationLogger,
): { simulated: true; simulatedPath: string; simulatedReason: string } {
  const entry = registry.get(id);
  const reason = entry ? entry.needs : 'not implemented against a real device';

  if (entry) {
    entry.invocations += 1;
    if (entry.firstUsedAt === null) entry.firstUsedAt = new Date().toISOString();
  }

  if (!warned.has(id)) {
    warned.add(id);
    logger?.warn(
      `SIMULATED: ${id} produced a result without touching a real device. ` +
        `${entry?.what ?? ''} Needed to make it real: ${reason}`.trim(),
    );
  }

  return { simulated: true, simulatedPath: id, simulatedReason: reason };
}

/** Everything declared, whether or not it has been used. */
export function simulatedPaths(): SimulatedPath[] {
  return Array.from(registry.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** Only the paths that have actually run. */
export function usedSimulatedPaths(): SimulatedPath[] {
  return simulatedPaths().filter((p) => p.invocations > 0);
}

/**
 * A health check reporting the agent's simulated surface.
 *
 * Deliberately `degraded`, never `healthy`: an agent answering with data it did
 * not measure is not fully working, and an operator reading a green dashboard
 * should not have to dig to discover that.
 */
export function simulationHealthCheck(agentPrefix: string): {
  name: string;
  status: 'healthy' | 'degraded';
  message: string | undefined;
  simulated: boolean;
} {
  const mine = simulatedPaths().filter((p) => p.id.startsWith(agentPrefix));
  if (mine.length === 0) {
    return { name: 'simulated_paths', status: 'healthy', message: undefined, simulated: false };
  }
  const used = mine.filter((p) => p.invocations > 0).length;
  return {
    name: 'simulated_paths',
    status: 'degraded',
    message:
      `${mine.length} code path(s) return simulated data (${used} exercised so far): ` +
      mine.map((p) => p.id.replace(`${agentPrefix}.`, '')).join(', '),
    simulated: true,
  };
}

/** Resets the registry. Tests only. */
export function resetSimulationRegistry(): void {
  registry.clear();
  warned.clear();
}
