const ping = require('ping');
const Logger = require('../utils/logger');

class PingMonitor {
  constructor(config, logger, metrics) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
  }

  async checkHealth(routerConfig) {
    const startTime = Date.now();
    const routerType = routerConfig === this.config.primary ? 'primary' : 'backup';
    const pingConfig = this.config.monitoring || {};
    
    try {
      const result = await ping.promise.probe(routerConfig.host, {
        timeout: (pingConfig.ping_timeout || 2000) / 1000,
        min_reply: pingConfig.ping_count || 4
      });

      const responseTime = (Date.now() - startTime) / 1000;

      if (result.alive) {
        this.metrics.recordHeartbeatSuccess(routerType, 'ping');
        this.metrics.recordPingDuration(routerType, result.time / 1000);
        
        this.logger.logHealthCheck({
          router: routerConfig.host,
          status: 'up',
          response_time: result.time / 1000,
          method: 'ping',
          packet_loss: result.packetLoss
        });

        return {
          success: true,
          responseTime: result.time / 1000,
          data: {
            host: routerConfig.host,
            alive: result.alive,
            time: result.time,
            packetLoss: result.packetLoss,
            min: result.min,
            max: result.max,
            avg: result.avg,
            stddev: result.stddev
          }
        };
      } else {
        this.metrics.recordPingPacketLoss(routerType);
        
        this.logger.warn(`Ping failed for ${routerConfig.host}`, {
          packet_loss: result.packetLoss,
          response_time: responseTime
        });

        return {
          success: false,
          responseTime,
          data: {
            host: routerConfig.host,
            alive: false,
            packetLoss: result.packetLoss
          }
        };
      }
    } catch (error) {
      const responseTime = (Date.now() - startTime) / 1000;
      
      this.logger.error(`Ping health check failed for ${routerConfig.host}`, {
        error: error.message,
        responseTime
      });

      return {
        success: false,
        responseTime,
        error: error.message
      };
    }
  }

  async continuousPing(routerConfig, callback) {
    const pingInterval = this.config.monitoring?.ping_interval || 10000;
    
    const pingLoop = async () => {
      try {
        const result = await this.checkHealth(routerConfig);
        callback(result);
      } catch (error) {
        this.logger.error(`Continuous ping error for ${routerConfig.host}`, {
          error: error.message
        });
      }
    };

    // Initial ping
    await pingLoop();

    // Set up interval
    return setInterval(pingLoop, pingInterval);
  }

  async measureLatency(routerConfig, samples = 10) {
    const latencies = [];
    
    for (let i = 0; i < samples; i++) {
      try {
        const result = await ping.promise.probe(routerConfig.host, {
          timeout: 1,
          min_reply: 1
        });
        
        if (result.alive) {
          latencies.push(result.time);
        }
      } catch (error) {
        // Skip failed pings
      }
      
      // Small delay between pings
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (latencies.length === 0) {
      return {
        min: 0,
        max: 0,
        avg: 0,
        loss: 100
      };
    }

    return {
      min: Math.min(...latencies),
      max: Math.max(...latencies),
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      loss: ((samples - latencies.length) / samples) * 100,
      samples: latencies.length
    };
  }

  close() {
    // Cleanup if needed
  }
}

module.exports = PingMonitor;