const { z } = require('zod');

/**
 * Schema for router.yml, the master config every agent's own config is
 * generated from.
 *
 * Before this, a missing key surfaced as
 * `TypeError: Cannot read properties of undefined (reading 'host')` with a
 * stack trace pointing into config-manager - which tells an operator nothing
 * about which key in which file is wrong. Validation here fails fast and names
 * the path.
 */

const Port = z.number().int().min(1).max(65535);

/** Hostname or IP. Deliberately permissive - resolution is the network's job. */
const Host = z.string().min(1, 'must not be empty');

const RouterSchema = z.object({
  host: Host,
  snmp_community: z.string().min(1),
  snmp_version: z.enum(['1', '2c', '3']).default('2c'),
  snmp_port: Port.default(161),
  location: z.string().default('unknown'),
  type: z.string().default('generic'),
});

/** Every agent shares these two, whatever else it needs. */
const AgentBase = {
  enabled: z.boolean().default(true),
  port: Port,
};

const MasterConfigSchema = z
  .object({
    router: z.object({
      primary: RouterSchema,
      backup: RouterSchema,
    }),

    syslog: z.object({
      port: Port.default(514),
      protocol: z.enum(['udp', 'tcp']).default('udp'),
    }),

    snmp_traps: z.object({
      port: Port.default(162),
      protocol: z.enum(['udp', 'tcp']).default('udp'),
    }),

    agents: z.object({
      monitoring: z.object({
        ...AgentBase,
        metrics_interval: z.number().int().positive().default(30),
      }),
      resilience: z.object({
        ...AgentBase,
        auto_failover: z.boolean().default(true),
        heartbeat_interval: z.number().int().positive().default(5),
        max_missed_heartbeats: z.number().int().positive().default(3),
        failback_enabled: z.boolean().default(true),
        failback_delay: z.number().int().nonnegative().default(30),
      }),
      security: z.object({
        ...AgentBase,
        alert_level: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
        max_failed_attempts: z.number().int().positive().default(5),
      }),
      performance: z.object({
        ...AgentBase,
        auto_optimize: z.boolean().default(false),
        threshold_cpu: z.number().min(0).max(100).default(80),
        threshold_memory: z.number().min(0).max(100).default(85),
        threshold_latency: z.number().positive().default(100),
      }),
      automation: z.object({
        ...AgentBase,
        // Writes configuration to live network hardware. Defaults off, and
        // agent5 additionally requires an action allowlist and dry_run: false.
        auto_heal: z.boolean().default(false),
        compliance_check_interval: z.number().int().positive().default(300),
      }),
      correlation: z.object(AgentBase),
      reporting: z.object(AgentBase),
      remediation: z.object(AgentBase),
      chatops: z.object(AgentBase),
    }),

    orchestrator: z.object({
      api_port: Port.default(8080),
      bind_host: z.string().default('127.0.0.1'),
      health_check_interval: z.number().int().positive().default(10),
      auto_restart_failed_agents: z.boolean().default(true),
      log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    }),

    prometheus: z.object({
      port: Port.default(9095),
      scrape_interval: z.number().int().positive().default(15),
    }),

    grafana: z.object({
      port: Port.default(3000),
      admin_user: z.string().default('admin'),
      admin_password: z.string().default('admin'),
    }),
  })
  .superRefine((cfg, ctx) => {
    // A port collision between two agents produces an EADDRINUSE deep inside
    // whichever one loses the race, several seconds after startup. Catching it
    // here names both offenders up front.
    const seen = new Map();
    const claim = (port, who) => {
      if (seen.has(port)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents'],
          message: `port ${port} is claimed by both ${seen.get(port)} and ${who}`,
        });
      } else {
        seen.set(port, who);
      }
    };

    for (const [name, agent] of Object.entries(cfg.agents)) {
      if (agent.enabled) claim(agent.port, `agents.${name}`);
    }
    claim(cfg.orchestrator.api_port, 'orchestrator.api_port');
    claim(cfg.prometheus.port, 'prometheus.port');

    if (cfg.router.primary.host === cfg.router.backup.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['router', 'backup', 'host'],
        message:
          'backup router has the same host as the primary, so failover would ' +
          'switch to the device that just failed',
      });
    }
  });

module.exports = { MasterConfigSchema };
