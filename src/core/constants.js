'use strict';

// Obsidian view type identifiers, used to register/find/activate each of the plugin's views.
const VIEW_TYPE_AI_CHAT = 'ai-chat-sidebar-view';
const VIEW_TYPE_AI_AGENT = 'ai-agent-sidebar-view';
const VIEW_TYPE_AI_VILLAGE = 'ai-village-view';

const DEFAULT_SETTINGS = {
  providers: [
    {
      id: 'claude',
      name: 'Claude',
      type: 'anthropic',
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    },
    {
      id: 'custom-openai',
      name: 'Custom (OpenAI-compatible)',
      type: 'openai-compatible',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    },
  ],
  activeProviderId: 'claude',
  systemPrompt: '',
  includeActiveNote: false,
  organizeMaxFiles: 150,
  agentMaxSteps: 20,
  agentAutoApprove: false,
  agentTeam: [],
};

// The plain chat sidebar has no tool-calling loop at all (unlike the Agent) — it just sends
// messages and shows back whatever text comes back. Without this, some models will still
// occasionally emit fake tool-call-looking text (as if they had a web_search tool) when asked
// something time-sensitive, which then shows up verbatim as the reply. This baseline system
// text heads that off; it's prepended to (not a replacement for) the user's own System Prompt
// setting.
const CHAT_NO_TOOLS_SYSTEM_NOTE =
  'You are chatting inside a note-taking app\'s sidebar panel. You do not have any tools, ' +
  'plugins, file access, or live internet/web-search access in this conversation — you can ' +
  'only use your own built-in knowledge. Do not simulate, describe, or emit any tool-call-style ' +
  'syntax or placeholder function calls. If a question needs real-time or web information you ' +
  'don\'t have, just say so plainly instead of pretending to look it up.';

module.exports = {
  VIEW_TYPE_AI_CHAT,
  VIEW_TYPE_AI_AGENT,
  VIEW_TYPE_AI_VILLAGE,
  DEFAULT_SETTINGS,
  CHAT_NO_TOOLS_SYSTEM_NOTE,
};
