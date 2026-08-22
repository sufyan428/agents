const path = require('path');
const { loadConfig, applyEnvMap } = require('@ragent/agent-common');
const yaml = require('js-yaml');
const fs = require('fs');
const logger = require('./utils/logger');
const { MasterConfigSchema } = require('./schema');

class ConfigManager {
  constructor() {
    this.masterConfig = null;
    this.configPath = path.join(__dirname, '..', 'router.yml');
  }

  /**
   * Load master configuration from router.yml
   */
  /**
   * Loads and validates router.yml.
   *
   * Throws a ConfigError naming the offending key. Callers should let it
   * reach the top: a framework that can stop agents and write to routers
   * must not start on a config it could not fully understand.
   */
  loadMasterConfig() {
    this.masterConfig = loadConfig({
      file: this.configPath,
      schema: MasterConfigSchema,
      envOverrides: (raw, env) => {
        applyEnvMap(
          raw,
          {
            BIND_HOST: 'orchestrator.bind_host',
            API_PORT: 'orchestrator.api_port',
            LOG_LEVEL: 'orchestrator.log_level',
            ROUTER_PRIMARY_HOST: 'router.primary.host',
            ROUTER_BACKUP_HOST: 'router.backup.host',
            SNMP_COMMUNITY: 'router.primary.snmp_community',
          },
          env,
        );
      },
    });
    logger.info('Master configuration loaded and validated');
    return this.masterConfig;
  }

  /**
   * Generate configuration for Agent 1 (Monitoring)
   */
  generateAgent1Config() {
    if (!this.masterConfig) {
      throw new Error('Master config not loaded');
    }

    const config = {
      // agent1's ConfigLoader expects a plural `routers` array
      // (config.getEnabledRouters()/.getRouter(name)/.filter(...)), not a
      // singular `router` object — it's built to poll multiple routers.
      routers: [
        {
          name: this.masterConfig.router.primary.location || 'Primary-Router',
          enabled: true,
          ip: this.masterConfig.router.primary.host,
          community: this.masterConfig.router.primary.snmp_community,
          port: this.masterConfig.router.primary.snmp_port,
          version: this.masterConfig.router.primary.snmp_version,
          poll_interval: this.masterConfig.agents.monitoring.metrics_interval,
        },
      ],
      default_oids: {
        uptime: '1.3.6.1.2.1.1.3.0',
        // Cisco-specific. Wrong on other vendors, which is why an
        // unsupported OID must degrade quietly rather than crash.
        cpu: '1.3.6.1.4.1.9.9.109.1.1.1.1.8.1',
        memory_used: '1.3.6.1.4.1.9.9.48.1.1.1.5.1',
        // CISCO-MEMORY-POOL-MIB has no "total" object. Column 6 is
        // Free and column 7 is LargestFree - the config previously
        // used column 7 as the total, so the memory percentage was
        // computed as used/largestFree and was wrong on real hardware.
        // Total is used + free.
        memory_free: '1.3.6.1.4.1.9.9.48.1.1.1.6.1',
        // IF-MIB, standard across vendors. These were referenced by
        // agent1's interface collector but never distributed, so it
        // built the OID string "undefined.1" and sent garbage to the
        // device on every poll.
        interface_in: '1.3.6.1.2.1.2.2.1.10',
        interface_out: '1.3.6.1.2.1.2.2.1.16',
        interface_errors: '1.3.6.1.2.1.2.2.1.14',
      },
      syslog: {
        enabled: true,
        protocol: this.masterConfig.syslog.protocol,
        port: this.masterConfig.syslog.port,
      },
      snmp_traps: this.masterConfig.snmp_traps,
      server: {
        port: this.masterConfig.agents.monitoring.port,
      },
    };

    return config;
  }

  /**
   * Generate configuration for Agent 2 (Resilience & Failover)
   */
  generateAgent2Config() {
    if (!this.masterConfig) {
      throw new Error('Master config not loaded');
    }

    const config = {
      primary: {
        host: this.masterConfig.router.primary.host,
        community: this.masterConfig.router.primary.snmp_community,
        timeout: 5000,
        retries: 3,
      },
      backup: {
        host: this.masterConfig.router.backup.host,
        community: this.masterConfig.router.backup.snmp_community,
        timeout: 5000,
        retries: 3,
      },
      failover: {
        enabled: this.masterConfig.agents.resilience.enabled,
        heartbeat_interval: this.masterConfig.agents.resilience.heartbeat_interval * 1000,
        max_missed_heartbeats: this.masterConfig.agents.resilience.max_missed_heartbeats,
        failback_enabled: this.masterConfig.agents.resilience.failback_enabled,
        failback_delay: this.masterConfig.agents.resilience.failback_delay * 1000,
        auto_failback: this.masterConfig.agents.resilience.failback_enabled,
      },
      sync: {
        enabled: true,
        sync_interval: 60000,
        sync_on_failover: true,
        backup_path: './data/config-backups',
      },
      syslog: {
        enabled: true,
        protocol: 'udp',
        port: 5141,
      },
      metrics: {
        port: this.masterConfig.agents.resilience.port,
      },
      logging: {
        level: 'info',
        directory: './logs',
        max_size: '20m',
        max_files: '14d',
        date_pattern: 'YYYY-MM-DD',
      },
      server: {
        port: this.masterConfig.agents.resilience.port,
      },
    };

    return config;
  }

  /**
   * Generate configuration for Agent 3 (Security)
   */
  generateAgent3Config() {
    if (!this.masterConfig) {
      throw new Error('Master config not loaded');
    }

    const config = {
      router: {
        host: this.masterConfig.router.primary.host,
        port: this.masterConfig.router.primary.snmp_port,
        snmp: {
          community: this.masterConfig.router.primary.snmp_community,
          version: this.masterConfig.router.primary.snmp_version,
          timeout: 5000,
        },
      },
      security: {
        authentication: {
          max_failed_attempts: this.masterConfig.agents.security.max_failed_attempts,
          time_window_seconds: 300,
          lockout_threshold: 10,
        },
        traffic: {
          baseline_samples: 100,
          anomaly_threshold: 3.0,
          spike_threshold: 5.0,
        },
        configuration: {
          validation_interval: 300,
          critical_changes: ['acl', 'security-policy', 'firewall', 'nat'],
        },
      },
      syslog: {
        enabled: true,
        protocol: this.masterConfig.syslog.protocol,
        port: 5142,
      },
      icmp: {
        enabled: true,
        interval: 30,
        timeout: 5000,
      },
      alerts: {
        severity: {
          critical: { enabled: true },
          high: { enabled: true },
          medium: { enabled: true },
          low: { enabled: true },
        },
        channels: {
          console: true,
          log: true,
          webhook: false,
        },
        webhook: {
          url: '',
          timeout: 5000,
        },
      },
      logging: {
        level: 'info',
        directory: './logs',
        date_pattern: 'YYYY-MM-DD',
        max_size: '20m',
        max_files: '14d',
      },
      prometheus: {
        enabled: true,
        port: this.masterConfig.agents.security.port,
        path: '/metrics',
      },
      agent: {
        name: 'security-intrusion-detection-agent',
        instance: 'agent3-01',
        environment: 'production',
      },
      snmp_traps: this.masterConfig.snmp_traps,
      server: {
        port: this.masterConfig.agents.security.port,
      },
    };

    return config;
  }

  /**
   * Generate configuration for Agent 4 (Performance)
   */
  generateAgent4Config() {
    if (!this.masterConfig) {
      throw new Error('Master config not loaded');
    }

    const config = {
      router: {
        host: this.masterConfig.router.primary.host,
        snmp: {
          community: this.masterConfig.router.primary.snmp_community,
          port: this.masterConfig.router.primary.snmp_port,
          version: this.masterConfig.router.primary.snmp_version,
        },
      },
      optimization: {
        enabled: this.masterConfig.agents.performance.enabled,
        auto_apply: this.masterConfig.agents.performance.auto_optimize,
        threshold_cpu: this.masterConfig.agents.performance.threshold_cpu,
        threshold_memory: this.masterConfig.agents.performance.threshold_memory,
        threshold_latency: this.masterConfig.agents.performance.threshold_latency,
        threshold_jitter: 50,
      },
      qos: {
        enabled: true,
        priority_classes: [
          { name: 'critical', priority: 7, bandwidth_percent: 40 },
          { name: 'high', priority: 5, bandwidth_percent: 30 },
          { name: 'medium', priority: 3, bandwidth_percent: 20 },
          { name: 'low', priority: 1, bandwidth_percent: 10 },
        ],
      },
      traffic_balancing: {
        enabled: true,
        algorithm: 'round_robin',
        imbalance_threshold: 30,
      },
      icmp: {
        timeout: 5000,
        packet_size: 56,
      },
      syslog: {
        enabled: true,
        protocol: 'udp',
        port: 5143,
        bind_host: '0.0.0.0',
      },
      agent: {
        log_level: 'info',
        log_file: './logs/agent.log',
        metrics_port: this.masterConfig.agents.performance.port,
      },
      server: {
        port: this.masterConfig.agents.performance.port,
      },
    };

    return config;
  }

  /**
   * Generate configuration for Agent 5 (Automation & Governance)
   */
  generateAgent5Config() {
    if (!this.masterConfig) {
      throw new Error('Master config not loaded');
    }

    const config = {
      routers: [
        {
          name: 'Primary-Router',
          host: this.masterConfig.router.primary.host,
          snmp_community: this.masterConfig.router.primary.snmp_community,
          snmp_version: this.masterConfig.router.primary.snmp_version,
          snmp_port: this.masterConfig.router.primary.snmp_port,
          location: this.masterConfig.router.primary.location,
          type: this.masterConfig.router.primary.type,
        },
      ],
    };

    return config;
  }

  /**
   * Generate agent5's config.yml (app-level settings — separate file from
   * router.yml; agent5's ConfigLoader reads server/governance/syslog/logging
   * from config.yml and only the `routers` list from router.yml)
   */
  generateAgent5AppConfig() {
    if (!this.masterConfig) {
      throw new Error('Master config not loaded');
    }

    return {
      server: {
        port: this.masterConfig.agents.automation.port,
        metrics_path: '/metrics',
        health_path: '/health',
      },
      governance: {
        auto_heal: this.masterConfig.agents.automation.auto_heal === true,
        enforce_policies: true,
        backup_before_changes: true,
        approval_required: false,
      },
      scheduling: {
        policy_check_interval: '*/5 * * * *',
        backup_interval: '0 2 * * *',
        firmware_check_interval: '0 3 * * 0',
        audit_report_interval: '0 6 * * 0',
        config_compliance_check: '*/10 * * * *',
      },
      backup: {
        enabled: true,
        retention_days: 30,
        directory: './configs/backups',
        compression: true,
      },
      logging: {
        level: 'info',
        directory: './logs',
        max_files: 10,
        max_size: '10m',
      },
      metrics: {
        enabled: true,
        port: this.masterConfig.agents.automation.port,
      },
      audit: {
        enabled: true,
        directory: './logs/audit',
        format: 'json',
        include_details: true,
      },
      self_healing: {
        enabled: true,
        // Even with auto_heal on, nothing is written to a device unless
        // the action is named here AND dry_run is explicitly false.
        dry_run: true,
        allowed_actions: [],
        max_retries: 3,
        retry_delay: 60,
        notify_on_failure: true,
      },
      notifications: {
        enabled: false,
        email: { enabled: false },
        webhook: { enabled: false },
      },
      syslog: {
        enabled: true,
        protocol: 'udp',
        port: 5144,
      },
    };
  }

  /**
   * Distribute configurations to all agent directories
   */
  distributeConfigs() {
    try {
      const agentsDir = path.join(__dirname, '..', '..');
      const results = [];

      // Agent 1 config
      const agent1Config = this.generateAgent1Config();
      const agent1Path = path.join(agentsDir, 'agent1', 'config', 'router.yml');
      results.push(this.writeConfig(agent1Path, agent1Config));
      logger.info('Agent 1 configuration distributed');

      // Agent 2 config
      const agent2Config = this.generateAgent2Config();
      const agent2Path = path.join(agentsDir, 'agent2', 'config', 'router.yml');
      results.push(this.writeConfig(agent2Path, agent2Config));
      logger.info('Agent 2 configuration distributed');

      // Agent 3 config
      const agent3Config = this.generateAgent3Config();
      const agent3Path = path.join(agentsDir, 'agent3', 'config', 'router.yml');
      results.push(this.writeConfig(agent3Path, agent3Config));
      logger.info('Agent 3 configuration distributed');

      // Agent 4 config
      const agent4Config = this.generateAgent4Config();
      const agent4Path = path.join(agentsDir, 'agent4', 'router.yml');
      results.push(this.writeConfig(agent4Path, agent4Config));
      logger.info('Agent 4 configuration distributed');

      // Agent 5 config (router.yml: routers list, config.yml: app/server settings)
      const agent5Config = this.generateAgent5Config();
      const agent5Path = path.join(agentsDir, 'agent5', 'router.yml');
      results.push(this.writeConfig(agent5Path, agent5Config));

      const agent5AppConfig = this.generateAgent5AppConfig();
      const agent5AppConfigPath = path.join(agentsDir, 'agent5', 'config.yml');
      results.push(this.writeConfig(agent5AppConfigPath, agent5AppConfig));
      logger.info('Agent 5 configuration distributed');

      const written = results.filter(Boolean).length;
      const unchanged = results.length - written;
      logger.info(
        `Configuration distribution complete: ${written} written, ${unchanged} unchanged`,
      );
      return { written, unchanged };
    } catch (error) {
      logger.error(`Failed to distribute configurations: ${error.message}`);
      throw error;
    }
  }

  /**
   * Writes a distributed config, but only when the content actually changed.
   *
   * Previously every boot rewrote all six agent config files unconditionally
   * and without a backup, so any hand-edit was silently destroyed on the next
   * restart. Now an unchanged file is left alone, and a changed one leaves a
   * .bak of what it replaced.
   *
   * Returns true when the file was written.
   */
  writeConfig(filePath, config) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const yamlStr = yaml.dump(config);

    if (fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, 'utf8');
      if (current === yamlStr) {
        logger.debug(`Config unchanged, leaving alone: ${filePath}`);
        return false;
      }
      fs.copyFileSync(filePath, `${filePath}.bak`);
      const changes = ConfigManager.summariseChange(current, yamlStr);
      logger.info(
        `Config changed: ${path.basename(filePath)} (${changes}). ` +
          `Previous version saved alongside as .bak`,
      );
    }

    fs.writeFileSync(filePath, yamlStr, 'utf8');
    return true;
  }

  /**
   * A one-line summary of which top-level keys a rewrite touches.
   *
   * Enough for an operator reading the log to see whether a restart changed
   * anything they care about, without dumping two YAML documents into it.
   * Secrets are never printed - only key names.
   */
  static summariseChange(oldYaml, newYaml) {
    try {
      const before = yaml.load(oldYaml) || {};
      const after = yaml.load(newYaml) || {};
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      const touched = [];
      for (const k of keys) {
        const a = JSON.stringify(before[k]);
        const b = JSON.stringify(after[k]);
        if (a !== b) touched.push(k);
      }
      return touched.length ? `changed: ${touched.join(', ')}` : 'formatting only';
    } catch {
      return 'unparseable previous version';
    }
  }

  /**
   * The master config with every secret removed.
   *
   * The previous implementation redacted only the two SNMP community strings
   * and returned grafana.admin_password in clear text over an unauthenticated
   * endpoint. This walks the whole tree instead, so a secret added to
   * router.yml later cannot be missed.
   */
  getRedactedConfig() {
    if (!this.masterConfig) this.loadMasterConfig();

    const SECRET_KEY = /pass|secret|token|community|credential|api[_-]?key|private/i;
    const walk = (value) => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(walk);
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY.test(k) ? '[redacted]' : walk(v);
      }
      return out;
    };

    return walk(JSON.parse(JSON.stringify(this.masterConfig)));
  }

  /**
   * Get orchestrator configuration
   */
  getOrchestratorConfig() {
    if (!this.masterConfig) {
      this.loadMasterConfig();
    }
    return this.masterConfig.orchestrator;
  }

  /**
   * Get all agent configurations
   */
  getAllAgentConfigs() {
    if (!this.masterConfig) {
      this.loadMasterConfig();
    }
    return this.masterConfig.agents;
  }
}

module.exports = new ConfigManager();
