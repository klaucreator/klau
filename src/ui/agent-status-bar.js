'use strict';

const { VILLAGE_PROFESSIONS } = require('../village/village-roster');

class AgentStatusBar {
  constructor(plugin) {
    this.plugin = plugin;
    this.containerEl = null;
    this.isExpanded = false;
    this.updateInterval = null;
  }

  create(container) {
    this.containerEl = container.createDiv({ cls: 'ai-agent-status-bar' });
    this.containerEl.innerHTML = `
      <div class="ai-agent-status-bar-inner">
        <span class="ai-agent-status-bar-label">Agents</span>
        <div class="ai-agent-status-bar-items"></div>
        <button class="ai-agent-status-bar-toggle" aria-label="Expand agent status">▼</button>
      </div>
      <div class="ai-agent-status-bar-expanded" style="display: none;">
        <div class="ai-agent-status-bar-expanded-header">
          <span>Active Agents</span>
          <button class="ai-agent-status-bar-close">×</button>
        </div>
        <div class="ai-agent-status-bar-expanded-list"></div>
      </div>
    `;

    const toggleBtn = this.containerEl.querySelector('.ai-agent-status-bar-toggle');
    const closeBtn = this.containerEl.querySelector('.ai-agent-status-bar-close');
    const expandedEl = this.containerEl.querySelector('.ai-agent-status-bar-expanded');

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleExpand();
    });

    closeBtn.addEventListener('click', () => {
      this.collapse();
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
      if (this.isExpanded && !this.containerEl.contains(e.target)) {
        this.collapse();
      }
    });

    this.startUpdates();
    return this.containerEl;
  }

  toggleExpand() {
    this.isExpanded = !this.isExpanded;
    const expandedEl = this.containerEl.querySelector('.ai-agent-status-bar-expanded');
    const toggleBtn = this.containerEl.querySelector('.ai-agent-status-bar-toggle');
    expandedEl.style.display = this.isExpanded ? 'block' : 'none';
    toggleBtn.textContent = this.isExpanded ? '▲' : '▼';
    if (this.isExpanded) {
      this.renderExpanded();
    }
  }

  collapse() {
    this.isExpanded = false;
    const expandedEl = this.containerEl.querySelector('.ai-agent-status-bar-expanded');
    const toggleBtn = this.containerEl.querySelector('.ai-agent-status-bar-toggle');
    expandedEl.style.display = 'none';
    toggleBtn.textContent = '▼';
  }

  startUpdates() {
    this.update();
    this.updateInterval = window.setInterval(() => this.update(), 2000);
  }

  stopUpdates() {
    if (this.updateInterval) {
      window.clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  update() {
    const village = this.plugin.village;
    if (!village) return;

    const agents = Array.from(village.villagers.values())
      .filter(v => !v.isSubagent)
      .filter(v => v.status !== 'idle' || v.subStatus);

    const itemsEl = this.containerEl.querySelector('.ai-agent-status-bar-items');
    if (!itemsEl) return;

    if (agents.length === 0) {
      itemsEl.innerHTML = '<span class="ai-agent-status-bar-idle">All idle</span>';
      return;
    }

    itemsEl.innerHTML = agents.map(v => {
      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      const emoji = prof ? prof.emoji : '👤';
      const statusIcon = this.getStatusIcon(v.status, v.subStatus);
      const isWaiting = v.status === 'waiting' || v.status === 'error';
      return `
        <span class="ai-agent-status-bar-agent ${isWaiting ? 'needs-attention' : ''}" 
              data-key="${v.key}"
              title="${v.name}: ${v.status}${v.subStatus ? ':' + v.subStatus : ''}${v.taskText ? ' - ' + v.taskText.slice(0, 40) : ''}">
          ${emoji} ${statusIcon} ${v.name}
        </span>
      `;
    }).join('');

    // Add click handlers for each agent
    itemsEl.querySelectorAll('.ai-agent-status-bar-agent').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        this.showAgentDetails(key);
      });
    });
  }

  getStatusIcon(status, subStatus) {
    switch (status) {
      case 'working': return subStatus === 'reading' ? '📖' : subStatus === 'writing' ? '✍️' : '⚙️';
      case 'meeting': return '🗣️';
      case 'reviewing': return '💭';
      case 'waiting': return '⌛';
      case 'finished': return '✨';
      case 'error': return '⚠️';
      case 'walking': return '🚶';
      default: return '🙂';
    }
  }

  renderExpanded() {
    const village = this.plugin.village;
    if (!village) return;

    const agents = Array.from(village.villagers.values())
      .filter(v => !v.isSubagent);

    const listEl = this.containerEl.querySelector('.ai-agent-status-bar-expanded-list');
    if (!listEl) return;

    listEl.innerHTML = agents.map(v => {
      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      const emoji = prof ? prof.emoji : '👤';
      const statusIcon = this.getStatusIcon(v.status, v.subStatus);
      const isWaiting = v.status === 'waiting' || v.status === 'error';
      return `
        <div class="ai-agent-status-bar-expanded-item ${isWaiting ? 'needs-attention' : ''}" data-key="${v.key}">
          <div class="ai-agent-status-bar-expanded-main">
            <span class="ai-agent-status-bar-expanded-emoji">${emoji}</span>
            <span class="ai-agent-status-bar-expanded-name">${v.name}</span>
            <span class="ai-agent-status-bar-expanded-status">${statusIcon} ${v.status}${v.subStatus ? ':' + v.subStatus : ''}</span>
          </div>
          ${v.taskText ? `<div class="ai-agent-status-bar-expanded-task">${v.taskText.slice(0, 80)}</div>` : ''}
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.ai-agent-status-bar-expanded-item').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        this.showAgentDetails(key);
      });
    });
  }

  showAgentDetails(key) {
    const village = this.plugin.village;
    const v = village?.villagers.get(key);
    if (!v) return;

    // Create a modal-like toast with details
    const toast = document.createElement('div');
    toast.className = 'ai-agent-status-bar-toast';
    toast.innerHTML = `
      <div class="ai-agent-status-bar-toast-content">
        <div class="ai-agent-status-bar-toast-header">
          <span>${VILLAGE_PROFESSIONS[v.professionKey]?.emoji || '👤'} ${v.name}</span>
          <button class="ai-agent-status-bar-toast-close">×</button>
        </div>
        <div class="ai-agent-status-bar-toast-body">
          <div><strong>Status:</strong> ${v.status}${v.subStatus ? ':' + v.subStatus : ''}</div>
          ${v.taskText ? `<div><strong>Task:</strong> ${v.taskText}</div>` : ''}
          ${v.bubble ? `<div><strong>Message:</strong> ${v.bubble.icon || ''} ${v.bubble.text}</div>` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(toast);
    toast.querySelector('.ai-agent-status-bar-toast-close').addEventListener('click', () => toast.remove());
    toast.addEventListener('click', (e) => { if (e.target === toast) toast.remove(); });

    // Auto-remove after 5 seconds
    setTimeout(() => toast.remove(), 5000);
  }

  destroy() {
    this.stopUpdates();
    if (this.containerEl) {
      this.containerEl.remove();
    }
  }
}

module.exports = { AgentStatusBar };