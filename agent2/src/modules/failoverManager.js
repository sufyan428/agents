const { declareSimulated, markSimulated } = require('@ragent/agent-common');

// Declared at load so /health advertises them even before anything runs.
declareSimulated(
  'agent2.executeFailover',
  'Reports a successful failover without changing any routing state.',
  'VRRP priority change, BGP route manipulation, or a vendor API call'
);
declareSimulated(
  'agent2.executeFailback',
  'Reports a successful failback without changing any routing state.',
  'restoring the VRRP priority or BGP routes changed during failover'
);
declareSimulated(
  'agent2.verifyBackupAvailability',
  'Always reports the backup as available.',
  'an SNMP or ICMP check against the backup before switching to it'
);
declareSimulated(
  'agent2.verifyPrimaryStability',
  'Always reports the primary as stable.',
  'a sustained health check over a window before failing back'
);

const fs = require('fs');
const path = require('path');

class FailoverManager {
  constructor(config, logger, metrics) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    
    this.currentActiveRouter = 'primary'; // 'primary' or 'backup'
    this.failoverState = 'normal'; // 'normal', 'failing-over', 'failed-over', 'failing-back'
    this.failoverHistory = [];
    this.stateFile = config.state?.file || '/app/data/state.json';
    
    this.loadState();
  }

  async handleFailover(event) {
    this.logger.info('Processing failover event', {
      event_type: event.type,
      failed_router: event.failedRouter,
      reason: event.reason
    });

    if (event.type === 'failover') {
      return await this.performFailover(event);
    } else if (event.type === 'failback') {
      return await this.performFailback(event);
    }

    return { success: false, message: 'Unknown event type' };
  }

  async performFailover(event) {
    const startTime = Date.now();
    
    try {
      this.failoverState = 'failing-over';
      
      this.logger.critical('FAILOVER INITIATED', {
        from: 'primary',
        to: 'backup',
        reason: event.reason,
        timestamp: new Date().toISOString()
      });

      // Check if backup is available
      const backupAvailable = await this.verifyBackupAvailability();
      if (!backupAvailable) {
        throw new Error('Backup router is not available for failover');
      }

      // Execute failover logic
      const failoverResult = await this.executeFailover();
      
      if (failoverResult.success) {
        this.currentActiveRouter = 'backup';
        this.failoverState = 'failed-over';
        
        // Update metrics
        this.metrics.recordFailover('manual', event.reason);
        this.metrics.setActiveRouter(
          this.config.backup.host,
          'backup'
        );

        // Record history
        this.recordFailoverEvent({
          type: 'failover',
          from: 'primary',
          to: 'backup',
          reason: event.reason,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          success: true
        });

        // Save state
        this.saveState();

        // Sync configuration if enabled
        if (this.config.sync?.sync_on_failover) {
          await this.triggerConfigSync('failover');
        }

        this.logger.logFailover({
          type: 'failover',
          primary: this.config.primary.host,
          backup: this.config.backup.host,
          reason: event.reason,
          action: 'switched to backup',
          duration: Date.now() - startTime
        });

        return {
          success: true,
          message: 'Failover completed successfully',
          activeRouter: 'backup',
          duration: Date.now() - startTime
        };
      } else {
        throw new Error(failoverResult.message || 'Failover execution failed');
      }

    } catch (error) {
      this.failoverState = 'normal';
      this.logger.error('Failover failed', {
        error: error.message,
        stack: error.stack
      });

      this.metrics.recordFailover('failed', error.message);

      return {
        success: false,
        message: `Failover failed: ${error.message}`,
        error: error.message
      };
    }
  }

  async performFailback(event) {
    const startTime = Date.now();
    
    try {
      this.failoverState = 'failing-back';
      
      this.logger.info('FAILBACK INITIATED', {
        from: 'backup',
        to: 'primary',
        reason: event.reason,
        timestamp: new Date().toISOString()
      });

      // Wait for configured delay before failback
      const delay = this.config.failover?.failback_delay || 30000;
      this.logger.info(`Waiting ${delay}ms before failback`);
      await this.sleep(delay);

      // Verify primary is stable
      const primaryStable = await this.verifyPrimaryStability();
      if (!primaryStable) {
        throw new Error('Primary router is not stable for failback');
      }

      // Execute failback logic
      const failbackResult = await this.executeFailback();
      
      if (failbackResult.success) {
        this.currentActiveRouter = 'primary';
        this.failoverState = 'normal';
        
        // Update metrics
        this.metrics.recordFailback(event.reason);
        this.metrics.setActiveRouter(
          this.config.primary.host,
          'primary'
        );

        // Record history
        this.recordFailoverEvent({
          type: 'failback',
          from: 'backup',
          to: 'primary',
          reason: event.reason,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          success: true
        });

        // Save state
        this.saveState();

        // Sync configuration if enabled
        if (this.config.sync?.sync_on_failback) {
          await this.triggerConfigSync('failback');
        }

        this.logger.logFailover({
          type: 'failback',
          primary: this.config.primary.host,
          backup: this.config.backup.host,
          reason: event.reason,
          action: 'switched to primary',
          duration: Date.now() - startTime
        });

        return {
          success: true,
          message: 'Failback completed successfully',
          activeRouter: 'primary',
          duration: Date.now() - startTime
        };
      } else {
        throw new Error(failbackResult.message || 'Failback execution failed');
      }

    } catch (error) {
      this.failoverState = 'failed-over'; // Stay on backup if failback fails
      this.logger.error('Failback failed', {
        error: error.message,
        stack: error.stack
      });

      this.metrics.recordFailover('failback_failed', error.message);

      return {
        success: false,
        message: `Failback failed: ${error.message}`,
        error: error.message
      };
    }
  }

  async verifyBackupAvailability() {
    markSimulated('agent2.verifyBackupAvailability', this.logger);
    this.logger.info('Verifying backup router availability (simulated - always available)');
    return true;
  }

  async verifyPrimaryStability() {
    markSimulated('agent2.verifyPrimaryStability', this.logger);
    this.logger.info('Verifying primary router stability (simulated - always stable)');
    return true;
  }

  /**
   * SIMULATED. Changes no routing state.
   *
   * A real implementation belongs here: VRRP priority changes, BGP route
   * manipulation, or a vendor API call. Until then this reports what it did
   * not do, and says so in the result, the logs, the metrics and /health.
   */
  async executeFailover() {
    this.logger.info('Executing failover logic');
    await this.sleep(1000);

    return {
      ...markSimulated('agent2.executeFailover', this.logger),
      success: true,
      applied: false,
      message: 'Failover recorded, but no routing change was made (simulated)'
    };
  }

  /** SIMULATED. See executeFailover. */
  async executeFailback() {
    this.logger.info('Executing failback logic');
    await this.sleep(1000);

    return {
      ...markSimulated('agent2.executeFailback', this.logger),
      success: true,
      applied: false,
      message: 'Failback recorded, but no routing change was made (simulated)'
    };
  }

  async triggerConfigSync(triggerType) {
    this.logger.info(`Triggering config sync on ${triggerType}`);
    // This would be handled by the ConfigSync module
  }

  recordFailoverEvent(event) {
    this.failoverHistory.push(event);
    
    // Keep only last 100 events
    if (this.failoverHistory.length > 100) {
      this.failoverHistory = this.failoverHistory.slice(-100);
    }
  }

  saveState() {
    try {
      const state = {
        currentActiveRouter: this.currentActiveRouter,
        failoverState: this.failoverState,
        lastUpdated: new Date().toISOString(),
        failoverHistory: this.failoverHistory.slice(-10) // Save last 10 events
      };

      const stateDir = path.dirname(this.stateFile);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }

      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
      
      this.logger.debug('State saved successfully', {
        active_router: this.currentActiveRouter,
        state: this.failoverState
      });
    } catch (error) {
      this.logger.error('Failed to save state', {
        error: error.message
      });
    }
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const stateData = fs.readFileSync(this.stateFile, 'utf8');
        const state = JSON.parse(stateData);
        
        this.currentActiveRouter = state.currentActiveRouter || 'primary';
        this.failoverState = state.failoverState || 'normal';
        this.failoverHistory = state.failoverHistory || [];
        
        // Update metrics based on loaded state
        this.metrics.setActiveRouter(
          this.currentActiveRouter === 'primary' 
            ? this.config.primary.host 
            : this.config.backup.host,
          this.currentActiveRouter
        );
        
        this.logger.info('State loaded successfully', {
          active_router: this.currentActiveRouter,
          state: this.failoverState
        });
      }
    } catch (error) {
      this.logger.warn('Failed to load state, using defaults', {
        error: error.message
      });
    }
  }

  async checkAutoFailback(primaryHealthy) {
    if (!this.config.failover?.auto_failback) {
      return;
    }

    if (this.currentActiveRouter === 'backup' && 
        this.failoverState === 'failed-over' &&
        primaryHealthy) {
      
      this.logger.info('Primary router recovered, initiating auto failback');
      
      await this.handleFailover({
        type: 'failback',
        reason: 'primary-router-recovered'
      });
    }
  }

  getStatus() {
    return {
      currentActiveRouter: this.currentActiveRouter,
      failoverState: this.failoverState,
      failoverHistoryCount: this.failoverHistory.length,
      lastFailover: this.failoverHistory[this.failoverHistory.length - 1] || null
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = FailoverManager;