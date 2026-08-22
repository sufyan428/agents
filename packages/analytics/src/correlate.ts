/**
 * Deterministic incident correlation.
 *
 * Ten agents watching one network produce ten reports of the same event. A
 * router loses power and the operator gets: SNMP unreachable, ICMP loss,
 * interface down, heartbeat missed, compliance check failed, config backup
 * failed. Six alerts, one cause. Paging someone six times is how alerting
 * earns the reputation it has.
 *
 * This does the grouping and ranking with no model involved, for two reasons.
 * It has to work when the AI layer is switched off, which is the framework's
 * central promise. And a root cause that follows a stated dependency graph can
 * be explained to an operator who disagrees with it - "agent2 reported the
 * device unreachable, and these five are downstream of that" - which a model's
 * opinion cannot.
 *
 * The AI layer then adds what it is actually good at: narrating the cluster in
 * prose and suggesting what to do. It enriches this, it does not replace it.
 */

export interface CorrelatableFinding {
  id: string;
  agent: string;
  kind: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  entity: { type: string; id: string; name?: string };
  title: string;
  firstSeen: string;
  lastSeen: string;
  simulated?: boolean;
}

export interface Cluster {
  id: string;
  /** The finding judged to be the cause. */
  rootCause: CorrelatableFinding;
  /** Findings judged to be consequences of it. */
  symptoms: CorrelatableFinding[];
  /** Every finding in the cluster, root cause first. */
  all: CorrelatableFinding[];
  entity: string;
  severity: CorrelatableFinding['severity'];
  startedAt: string;
  lastActivityAt: string;
  /** How the root cause was chosen. Shown to the operator. */
  reasoning: string;
  /** 0..1. Below ~0.5 means the grouping is a guess. */
  confidence: number;
  agentsInvolved: string[];
  simulated: boolean;
}

const SEVERITY_RANK: Record<CorrelatableFinding['severity'], number> = {
  info: 0, low: 1, medium: 2, high: 3, critical: 4,
};

/**
 * Causal layers. A finding in a lower layer can explain one in a higher layer,
 * never the reverse.
 *
 * This encodes how a network actually fails: power and reachability precede
 * link state, which precedes protocol behaviour, which precedes performance
 * symptoms, which precede the policy checks that depend on all of it. Without
 * an ordering, correlation degrades into "these happened together", which is
 * where a naive implementation - and an unguided model - lands.
 */
const CAUSAL_LAYER: Array<{ layer: number; kinds: RegExp; label: string }> = [
  { layer: 0, kinds: /^(device_unreachable|power|snmp_timeout|icmp_total_loss|host_down)/, label: 'device reachability' },
  { layer: 1, kinds: /^(interface_down|link_down|interface_flap|carrier_loss)/, label: 'link state' },
  { layer: 2, kinds: /^(failover|failback|heartbeat_missed|route_change|bgp_|vrrp_)/, label: 'protocol and failover' },
  { layer: 3, kinds: /^(cpu_|memory_|resource_|temperature_)/, label: 'device resources' },
  { layer: 4, kinds: /^(latency_|jitter_|packet_loss|bandwidth_|qos_|throughput_)/, label: 'performance' },
  { layer: 5, kinds: /^(auth_failure|port_scan|intrusion|acl_|security_)/, label: 'security' },
  { layer: 6, kinds: /^(policy_|compliance_|config_drift|backup_|firmware_)/, label: 'policy and compliance' },
];

function layerOf(kind: string): { layer: number; label: string } {
  for (const entry of CAUSAL_LAYER) {
    if (entry.kinds.test(kind)) return { layer: entry.layer, label: entry.label };
  }
  // Unknown kinds sit between performance and security: low enough to be
  // explained by a real outage, high enough not to outrank a known cause.
  return { layer: 4.5, label: 'uncategorised' };
}

export interface CorrelateOptions {
  /** Findings this far apart are separate incidents even on the same entity. */
  windowMs?: number;
  /** Group findings about different entities when they overlap in time. */
  crossEntity?: boolean;
}

/**
 * Groups findings into incidents and names a probable cause for each.
 *
 * Same entity plus overlapping time is the primary grouping. Cross-entity
 * grouping is opt-in and deliberately weaker: two routers degrading at once is
 * usually one upstream problem, but saying so with confidence needs topology
 * this framework does not have, so the confidence reported reflects that.
 */
export function correlate(
  findings: readonly CorrelatableFinding[],
  { windowMs = 300_000, crossEntity = false }: CorrelateOptions = {},
): Cluster[] {
  if (findings.length === 0) return [];

  const sorted = [...findings].sort(
    (a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime(),
  );

  const groups = new Map<string, CorrelatableFinding[]>();

  for (const f of sorted) {
    const entityKey = `${f.entity.type}:${f.entity.id}`;
    const at = new Date(f.firstSeen).getTime();

    // Join an open group for this entity whose activity is still within the
    // window; otherwise start a new one.
    let joined = false;
    for (const [key, members] of groups) {
      if (!key.startsWith(`${entityKey}@`)) continue;
      const last = Math.max(...members.map((m) => new Date(m.lastSeen).getTime()));
      if (at - last <= windowMs) { members.push(f); joined = true; break; }
    }
    if (!joined) groups.set(`${entityKey}@${at}`, [f]);
  }

  let clusters = Array.from(groups.entries()).map(([key, members]) => buildCluster(key, members));

  if (crossEntity) clusters = mergeOverlapping(clusters, windowMs);

  return clusters.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.all.length - a.all.length,
  );
}

function buildCluster(key: string, members: CorrelatableFinding[]): Cluster {
  // Lowest causal layer wins; ties break on severity, then on which came first.
  const ranked = [...members].sort((a, b) => {
    const la = layerOf(a.kind).layer;
    const lb = layerOf(b.kind).layer;
    if (la !== lb) return la - lb;
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime();
  });

  const rootCause = ranked[0] as CorrelatableFinding;
  const symptoms = ranked.slice(1);
  const rootLayer = layerOf(rootCause.kind);

  const starts = members.map((m) => new Date(m.firstSeen).getTime());
  const ends = members.map((m) => new Date(m.lastSeen).getTime());
  const agents = [...new Set(members.map((m) => m.agent))].sort();

  return {
    id: `incident-${key.replace(/[^a-zA-Z0-9]/g, '-')}`,
    rootCause,
    symptoms,
    all: ranked,
    entity: rootCause.entity.name || rootCause.entity.id,
    severity: members.reduce<CorrelatableFinding['severity']>(
      (worst, m) => (SEVERITY_RANK[m.severity] > SEVERITY_RANK[worst] ? m.severity : worst),
      'info',
    ),
    startedAt: new Date(Math.min(...starts)).toISOString(),
    lastActivityAt: new Date(Math.max(...ends)).toISOString(),
    reasoning: explain(rootCause, symptoms, rootLayer.label, agents),
    confidence: confidenceOf(rootCause, symptoms, agents.length),
    agentsInvolved: agents,
    simulated: members.some((m) => m.simulated === true),
  };
}

function explain(
  root: CorrelatableFinding,
  symptoms: CorrelatableFinding[],
  layerLabel: string,
  agents: string[],
): string {
  if (symptoms.length === 0) {
    return `Single finding from ${root.agent}; nothing else correlates with it in the window.`;
  }
  const downstream = [...new Set(symptoms.map((s) => layerOf(s.kind).label))].filter((l) => l !== layerLabel);
  const parts = [
    `"${root.title}" is the deepest finding in this cluster (${layerLabel}), so it is the probable cause.`,
    `${symptoms.length} other finding${symptoms.length === 1 ? '' : 's'} across ${agents.length} agent${agents.length === 1 ? '' : 's'} occurred in the same window on the same entity`,
  ];
  if (downstream.length) parts.push(`and sit downstream of it (${downstream.join(', ')}).`);
  else parts.push('at the same causal layer.');
  return parts.join(' ');
}

/**
 * How much to trust the grouping.
 *
 * Higher when several independent agents agree, when the root cause is clearly
 * deeper than its symptoms, and when the root cause is severe. Lower when
 * everything sits at one layer, which usually means coincidence rather than
 * causation.
 */
function confidenceOf(root: CorrelatableFinding, symptoms: CorrelatableFinding[], agentCount: number): number {
  if (symptoms.length === 0) return 0.5;

  let score = 0.4;
  score += Math.min(agentCount - 1, 3) * 0.1;

  const rootLayer = layerOf(root.kind).layer;
  const deeper = symptoms.filter((s) => layerOf(s.kind).layer > rootLayer).length;
  score += (deeper / symptoms.length) * 0.25;

  if (SEVERITY_RANK[root.severity] >= 3) score += 0.1;
  if (layerOf(root.kind).label === 'uncategorised') score -= 0.15;

  return Math.round(Math.min(Math.max(score, 0), 0.95) * 100) / 100;
}

/**
 * Merges clusters on different entities that overlap in time.
 *
 * Confidence is capped afterwards: without a topology map this is an informed
 * guess, and it should not present as anything more.
 */
function mergeOverlapping(clusters: Cluster[], windowMs: number): Cluster[] {
  const out: Cluster[] = [];
  const used = new Set<string>();

  for (const c of clusters) {
    if (used.has(c.id)) continue;
    const overlapping = clusters.filter(
      (o) =>
        o.id !== c.id &&
        !used.has(o.id) &&
        Math.abs(new Date(o.startedAt).getTime() - new Date(c.startedAt).getTime()) <= windowMs,
    );
    if (overlapping.length === 0) { out.push(c); used.add(c.id); continue; }

    const members = [c, ...overlapping];
    for (const m of members) used.add(m.id);
    const all = members.flatMap((m) => m.all);
    const merged = buildCluster(`multi@${new Date(c.startedAt).getTime()}`, all);
    merged.reasoning =
      `${merged.reasoning} Spans ${members.length} entities within the same window, ` +
      'which often indicates a shared upstream cause - but this framework has no topology ' +
      'map, so that part is inference rather than evidence.';
    merged.confidence = Math.min(merged.confidence, 0.6);
    out.push(merged);
  }
  return out;
}

/**
 * Which findings a notifier should suppress: everything that is a symptom of
 * a confidently-identified cause.
 *
 * The threshold matters. Suppressing on a weak grouping hides real independent
 * problems, which is a worse failure than sending an extra alert.
 */
export function suppressibleFindingIds(clusters: readonly Cluster[], minConfidence = 0.6): Set<string> {
  const ids = new Set<string>();
  for (const c of clusters) {
    if (c.confidence < minConfidence) continue;
    for (const s of c.symptoms) ids.add(s.id);
  }
  return ids;
}
