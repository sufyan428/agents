const axios = require('axios');
const logger = require('../utils/logger');

class Notifier {
  constructor(config) {
    this.config = config;
  }

  get hasAnyWebhook() {
    return Boolean(this.config.notifications.slackWebhookUrl || this.config.notifications.discordWebhookUrl);
  }

  async send(text) {
    const { slackWebhookUrl, discordWebhookUrl } = this.config.notifications;

    if (!slackWebhookUrl && !discordWebhookUrl) {
      logger.info(`Notification (no webhook configured, logged only): ${text.slice(0, 200)}`);
      return;
    }

    if (slackWebhookUrl) {
      try {
        await axios.post(slackWebhookUrl, { text }, { timeout: 10000 });
      } catch (error) {
        logger.warn(`Slack webhook push failed: ${error.message}`);
      }
    }

    if (discordWebhookUrl) {
      try {
        // Discord caps message content at 2000 chars.
        await axios.post(discordWebhookUrl, { content: text.slice(0, 1900) }, { timeout: 10000 });
      } catch (error) {
        logger.warn(`Discord webhook push failed: ${error.message}`);
      }
    }
  }
}

module.exports = Notifier;
