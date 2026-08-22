const logger = require('../utils/logger');

const SYSTEM_PROMPT_TEMPLATE = `You are the natural-language interface for a router monitoring framework's orchestrator. Given a user's message, respond with ONLY a JSON object (no markdown code fences, no extra commentary) in exactly this shape:

{"action": "<one of the allowed actions below>", "agentName": "<agent name or null>", "reply": "<short natural-language reply to show the user right now>"}

Allowed actions:
- get_overview: overall framework status (no agentName needed)
- get_agent_status: status of one agent (needs agentName)
- get_agent_health: health check of one agent (needs agentName)
- get_incidents: recent cross-agent incident correlations
- get_reports: latest AI-generated digest report
- get_suggestions: latest remediation suggestions
- restart_agent / stop_agent / start_agent: control one agent (needs agentName) - these require human confirmation before anything actually happens, so just state clearly in "reply" what you're about to do
- chat: anything conversational, a greeting, or a question the framework can't directly answer - put your reply in "reply", agentName null

Valid agent names: {{KNOWN_AGENTS}}

If the user names an agent that isn't in that list, or is ambiguous about which agent they mean, use action "chat" and ask them to clarify in "reply" - do not guess an agent name.

Respond with valid JSON only, nothing before or after it.`;

class ChatEngine {
  constructor(config, llmClient, actionExecutor) {
    this.config = config;
    this.llmClient = llmClient;
    this.actionExecutor = actionExecutor;
    this.systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
      '{{KNOWN_AGENTS}}',
      config.known_agents.join(', ')
    );
  }

  parseIntent(text) {
    if (!text) return null;
    const attempts = [text.trim()];

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) attempts.push(fenceMatch[1].trim());

    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) attempts.push(braceMatch[0]);

    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed.action === 'string') {
          return parsed;
        }
      } catch (_error) {
        // try the next candidate
      }
    }
    return null;
  }

  /**
   * Processes one user message end to end. Returns:
   * - { reply, requiresConfirmation: false, result } for read-only/chat actions (already executed)
   * - { reply, requiresConfirmation: true, pendingAction } for destructive actions (NOT executed - caller must round-trip to /confirm)
   */
  async processMessage(message) {
    const llmResult = await this.llmClient.analyze(this.systemPrompt, message);

    if (!llmResult || !llmResult.text) {
      return { reply: "Sorry, I couldn't process that right now - try again in a moment.", requiresConfirmation: false, result: null };
    }

    const intent = this.parseIntent(llmResult.text);

    if (!intent || !this.actionExecutor.isValidAction(intent.action)) {
      // Model didn't return parseable/valid JSON - fall back to showing its raw text as a chat reply.
      return { reply: llmResult.text, requiresConfirmation: false, result: null };
    }

    const { action, agentName, reply } = intent;

    if (action === 'chat') {
      return { reply: reply || llmResult.text, requiresConfirmation: false, result: null };
    }

    if (this.actionExecutor.needsAgentName(action)) {
      if (!agentName || !this.actionExecutor.isKnownAgent(agentName)) {
        return {
          reply: reply || `Which agent do you mean? Valid names: ${this.config.known_agents.join(', ')}`,
          requiresConfirmation: false,
          result: null
        };
      }
    }

    if (this.actionExecutor.isDestructive(action)) {
      return {
        reply: reply || `About to run "${action}" on ${agentName} - confirm to proceed.`,
        requiresConfirmation: true,
        pendingAction: { action, agentName }
      };
    }

    const result = await this.actionExecutor.executeSafely(action, agentName);
    return { reply: reply || null, requiresConfirmation: false, result };
  }

  /**
   * Executes a previously-returned pendingAction after the human confirms it.
   * Re-validates from scratch - never trusts the client blindly.
   */
  async confirmAndExecute(pendingAction) {
    if (!pendingAction || !this.actionExecutor.isValidAction(pendingAction.action)) {
      return { success: false, error: 'Invalid or missing pendingAction' };
    }
    if (!this.actionExecutor.isDestructive(pendingAction.action)) {
      return { success: false, error: 'This action does not require confirmation - call it directly via chat' };
    }
    if (this.actionExecutor.needsAgentName(pendingAction.action) && !this.actionExecutor.isKnownAgent(pendingAction.agentName)) {
      return { success: false, error: `Unknown agent: ${pendingAction.agentName}` };
    }

    logger.info(`Confirmed action executing: ${pendingAction.action} on ${pendingAction.agentName}`);
    return this.actionExecutor.executeSafely(pendingAction.action, pendingAction.agentName);
  }
}

module.exports = ChatEngine;
