'use strict';

const { ItemView, Notice } = require('obsidian');
const { VIEW_TYPE_AI_AGENT } = require('../core/constants');
const { MUTATING_TOOLS, AGENT_EDITABLE_FIELDS } = require('../tools/tool-metadata');
const { sleep } = require('../agents/agent-loop');
const { villageSlug, resolveVillageProfession } = require('../village/village-roster');

class AgentView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.running = false;
  }

  getViewType() {
    return VIEW_TYPE_AI_AGENT;
  }
  getDisplayText() {
    return 'AI Agent';
  }
  getIcon() {
    return 'bot';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('ai-agent-container');

    container.createEl('p', {
      text:
        'Give the agent a goal. It reads/searches automatically, but pauses for your approval ' +
        'before writing, tagging, moving, or renaming anything (unless auto-approve is on in settings).',
      cls: 'setting-item-description',
    });

    const inputArea = container.createDiv({ cls: 'ai-agent-input-area' });
    this.goalInput = inputArea.createEl('textarea', {
      cls: 'ai-agent-input',
      attr: { placeholder: 'e.g. Find all notes about "project x" and add a #project-x tag to them', rows: '3' },
    });

    this.renderTeamNotice(container);

    const btnRow = inputArea.createDiv({ cls: 'ai-agent-btn-row' });
    this.stepCounterEl = btnRow.createDiv({ cls: 'ai-agent-step-counter' });
    this.copyBtn = btnRow.createEl('button', { text: 'Copy log' });
    this.runBtn = btnRow.createEl('button', { text: 'Run', cls: 'mod-cta' });
    this.stopBtn = btnRow.createEl('button', { text: 'Stop' });
    this.stopBtn.disabled = true;

    this.runBtn.addEventListener('click', () => this.startRun());
    this.stopBtn.addEventListener('click', () => {
      this.running = false;
      this.stopBtn.disabled = true;
      this.setStepCounter('Stopping after the current step…');
    });
    this.copyBtn.addEventListener('click', async () => {
      const text = Array.from(this.logEl.querySelectorAll('.ai-agent-step, .ai-agent-approval-label'))
        .map((el) => el.textContent)
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        new Notice('Agent log copied.');
      } catch (e) {
        new Notice('Could not copy log — clipboard access was denied.');
      }
    });

    this.logEl = container.createDiv({ cls: 'ai-agent-log' });
  }

  /**
   * Informational only — no picking here. If the user has defined a team in settings, the
   * Mayor always decides which members (if any) a goal actually needs, based on each role's
   * description vs. what the goal requires. An empty team still means "run solo."
   */
  renderTeamNotice(container) {
    const team = this.plugin.settings.agentTeam || [];
    if (team.length === 0) return;

    const box = container.createDiv({ cls: 'ai-agent-team-box' });
    box.createDiv({
      cls: 'ai-agent-team-label',
      text:
        `Team on file: ${team.map((m) => m.name || 'Untitled role').join(', ')}. The Mayor ` +
        'picks whichever of these (if any) fit each goal automatically — nothing to select here.',
    });
  }

  setStepCounter(text) {
    if (this.stepCounterEl) this.stepCounterEl.setText(text);
  }

  async startRun() {
    const goal = this.goalInput.value.trim();
    if (!goal) return;
    this.logEl.empty();
    this.running = true;
    this.runBtn.disabled = true;
    this.stopBtn.disabled = false;
    this.setStepCounter('');

    const team = this.plugin.settings.agentTeam || [];
    let selectedMembers = [];
    if (team.length > 0) {
      this.setStepCounter('Deciding which team members this needs…');
      try {
        selectedMembers = await this.plugin.selectTeamForGoal(goal, team);
      } catch (err) {
        this.logStep('error', `Could not auto-select the team (${err.message}) — running solo instead.`);
        selectedMembers = [];
      }
    }

    const village = this.plugin.village;

    if (selectedMembers.length === 0) {
      this.logStep('goal', goal);
      village.ensure('mayor', 'mayor', 'Mayor');
      await this.runStage(goal, null, null, 'mayor');
    } else {
      this.logStep('goal', goal);
      this.logStep(
        'team-header',
        `Auto-selected team: ${selectedMembers.map((m) => m.name).join(', ')}`
      );

      // No pre-work briefing and no scheduled time — each member heads straight to their
      // own building and gets to work the moment it's their turn. The Town Hall meeting
      // happens afterward, once the research/task is actually done (see below), not before.
      let prevReport = goal;
      let prevName = null;
      let prevKey = null;
      const finishedKeys = [];
      const finishedReports = new Map();

      for (const member of selectedMembers) {
        if (!this.running) break;
        this.logStep('team-header', `== ${member.name} ==`);
        const key = villageSlug(member.name);
        const professionKey = resolveVillageProfession(member.name, member.role);
        village.ensure(key, professionKey, member.name);
        if (prevKey) {
          village.messenger(prevKey, key, `I'll carry this over to ${member.name}.`);
        }
        const stageGoal = prevName
          ? `Overall goal: ${goal}\n\nThe previous team member ("${prevName}") reported:\n${prevReport}\n\nContinue toward the overall goal, focusing on your role.`
          : goal;
        const finalMsg = await this.runStage(stageGoal, member.role, member.name, key);
        if (finalMsg === null) break;
        prevReport = finalMsg;
        prevName = member.name;
        prevKey = key;
        finishedKeys.push(key);
        finishedReports.set(key, finalMsg);
      }

      // The Mayor — not the user — decides who actually needs to be at the wrap-up meeting:
      // everyone who finished, or just some of them, based on what each reported.
      let attendeeKeys = [];
      if (finishedKeys.length > 0 && this.running) {
        const finishedMembers = finishedKeys.map((key) => {
          const v = village.villagers.get(key);
          return { key, name: v ? v.name : key, report: finishedReports.get(key) || '' };
        });
        village.ensure('mayor', 'mayor', 'Mayor');
        village.setStatus('mayor', 'reviewing', { taskText: 'Deciding who needs to attend the meeting' });
        this.setStepCounter('The Mayor is deciding who should attend the meeting…');
        let attendees = finishedMembers;
        try {
          attendees = await this.plugin.selectMeetingAttendees(goal, finishedMembers);
        } catch (err) {
          this.logStep('error', `The Mayor couldn't decide attendees (${err.message}) — inviting everyone.`);
        }
        attendeeKeys = attendees.map((a) => a.key);
        this.logStep(
          'team-header',
          `The Mayor calls in: ${attendees.map((a) => a.name).join(', ') || '(no one — nothing to discuss)'}`
        );
      }

      // Attendees announce it — still at their own building — before anyone actually walks
      // over, then the group (plus the Mayor, presiding) heads to the Town Hall for the
      // wrap-up meeting. Straight from task to meeting, nothing scheduled in between, but no
      // one just teleports there silently either. Anyone the Mayor didn't call in just wraps
      // up quietly at their own building instead.
      if (attendeeKeys.length > 0 && this.running) {
        for (const key of attendeeKeys) {
          const v = village.villagers.get(key);
          if (!v) continue;
          village.say(key, "Done on my end — heading to the Town Hall.");
          this.logStep('meeting', `${v.name} announces they're heading to the Town Hall.`);
          await sleep(350);
        }

        this.setStepCounter('Meeting at the Town Hall…');
        village.setStatus('mayor', 'meeting', { taskText: 'Presiding over the meeting' });
        for (const key of attendeeKeys) {
          village.setStatus(key, 'meeting', { taskText: 'Heading to the Town Hall to report back' });
        }
        village.say('townhall', `The team regroups at the Town Hall to close out: "${goal.slice(0, 90)}"`);
        await sleep(1200); // lets the walk-to-Town-Hall animation actually play before they "arrive"

        for (const key of attendeeKeys) {
          if (!this.running) break;
          const v = village.villagers.get(key);
          if (!v) continue;
          village.setStatus(key, 'meeting', { taskText: 'Reporting back' });
          village.say(key, 'Reporting back — my part is done.');
          this.logStep('meeting', `${v.name} reports back at the Town Hall.`);
          await sleep(500);
        }
        await sleep(500);
        village.setStatus('mayor', 'finished', { taskText: 'Meeting closed' });
      }

      // Everyone finishes up together — whether they made it to the wrap-up meeting, wrapped
      // up quietly at their own building, or the run was stopped mid-way, nobody stays frozen
      // mid-status.
      for (const member of selectedMembers) {
        const key = villageSlug(member.name);
        const v = village.villagers.get(key);
        if (!v) continue;
        if (finishedKeys.includes(key)) {
          village.setStatus(key, 'finished', { taskText: 'Done' });
        } else if (v.status === 'meeting' || v.status === 'working') {
          village.setStatus(key, 'idle', { taskText: '' });
        }
      }
    }

    this.running = false;
    this.runBtn.disabled = false;
    this.stopBtn.disabled = true;
  }

  /**
   * Runs one agent loop to completion (or until stopped/erroring).
   * Returns the agent's final message string, or null if it didn't finish cleanly.
   */
  async runStage(goalText, roleText, label, villageKey) {
    const transcript = [{ role: 'user', content: goalText }];
    const maxSteps = this.plugin.settings.agentMaxSteps || 20;
    let steps = 0;
    const prefix = label ? `[${label}] ` : '';
    const village = this.plugin.village;
    const vkey = villageKey || 'mayor';

    village.setStatus(vkey, 'working', { taskText: 'Getting started...' });

    while (this.running && steps < maxSteps) {
      steps++;
      this.setStepCounter(`Step ${steps} / ${maxSteps}${label ? ` — ${label}` : ''}`);

      let raw;
      const thinkingEl = this.logStep('thinking', `${prefix}Thinking…`);
      try {
        raw = await this.plugin.agentCall(transcript, roleText, (partial) => {
          const preview = partial.length > 400 ? `…${partial.slice(-400)}` : partial;
          thinkingEl.setText(`${prefix}${preview}`);
          this.logEl.scrollTop = this.logEl.scrollHeight;
        });
      } catch (err) {
        thinkingEl.remove();
        this.logStep('error', `${prefix}${err.message}`);
        village.setStatus(vkey, 'error', { taskText: err.message.slice(0, 80) });
        village.say(vkey, `Something went wrong — ${err.message.slice(0, 70)}`);
        return null;
      }
      thinkingEl.remove();

      let parsed;
      try {
        parsed = this.plugin.parseAgentResponse(raw);
      } catch (err) {
        this.logStep('error', `${prefix}${err.message}`);
        village.setStatus(vkey, 'error', { taskText: err.message.slice(0, 80) });
        return null;
      }

      transcript.push({ role: 'assistant', content: JSON.stringify(parsed) });

      if (parsed.final) {
        this.logStep('final', `${prefix}${parsed.final}`);
        village.setStatus(vkey, 'finished', { taskText: 'Done' });
        village.say(vkey, parsed.final.slice(0, 90));
        this.setStepCounter('');
        return parsed.final;
      }

      if (!parsed.tool) {
        this.logStep('error', `${prefix}Agent response had neither "tool" nor "final".`);
        village.setStatus(vkey, 'error', { taskText: 'Confused response' });
        return null;
      }

      if (parsed.thought) {
        this.logStep('thought', `${prefix}${parsed.thought}`);
        village.setStatus(vkey, 'working', { taskText: parsed.thought.slice(0, 80) });
      }
      this.logStep('action', `${prefix}${parsed.tool}(${JSON.stringify(parsed.args || {})})`);
      village.setStatus(vkey, 'working', { taskText: `${parsed.tool}...` });

      const isMutating = MUTATING_TOOLS.has(parsed.tool);
      let resultText;

      if (isMutating && !this.plugin.settings.agentAutoApprove) {
        village.setStatus(vkey, 'waiting', { taskText: `Awaiting approval: ${parsed.tool}` });
        const decision = await this.askApproval(parsed.tool, parsed.args || {}, label);
        village.setStatus(vkey, 'working', { taskText: `${parsed.tool}...` });
        if (!decision.approved) {
          resultText = 'User skipped this action; it was not performed.';
          this.logStep('skipped', `${prefix}${resultText}`);
        } else {
          try {
            resultText = await this.plugin.runAgentTool(parsed.tool, decision.args);
            this.logStep('result', `${prefix}${resultText}`);
          } catch (err) {
            resultText = `Error: ${err.message}`;
            this.logStep('error', `${prefix}${resultText}`);
          }
        }
      } else {
        try {
          resultText = await this.plugin.runAgentTool(parsed.tool, parsed.args || {});
          this.logStep('result', `${prefix}${resultText}`);
        } catch (err) {
          resultText = `Error: ${err.message}`;
          this.logStep('error', `${prefix}${resultText}`);
        }
      }

      transcript.push({ role: 'user', content: `Tool result:\n${resultText}` });
    }

    if (steps >= maxSteps && this.running) {
      this.logStep('error', `${prefix}Reached the maximum step limit (change it in settings if needed).`);
      village.setStatus(vkey, 'error', { taskText: 'Ran out of steps' });
    } else if (!this.running) {
      village.setStatus(vkey, 'waiting', { taskText: 'Stopped' });
    }
    this.setStepCounter('');
    return null;
  }

  // Resolves to {approved: false} on Skip, or {approved: true, args} on Approve — args is the
  // original tool args, with the editable field (if this tool has one) replaced by whatever
  // the user left in the field.
  askApproval(tool, args, label) {
    return new Promise((resolve) => {
      const row = this.logEl.createDiv({ cls: 'ai-agent-approval' });
      row.createDiv({
        cls: 'ai-agent-approval-label',
        text: `${label ? `[${label}] ` : ''}Approve ${tool}?`,
      });

      const editableField = AGENT_EDITABLE_FIELDS[tool];
      let fieldInput = null;

      if (editableField && args[editableField] !== undefined) {
        const otherArgs = { ...args };
        delete otherArgs[editableField];
        if (Object.keys(otherArgs).length > 0) {
          row.createDiv({ cls: 'ai-agent-approval-context', text: JSON.stringify(otherArgs) });
        }
        row.createDiv({ cls: 'ai-agent-approval-field-label', text: `${editableField} (editable):` });
        const isLong = editableField === 'content';
        fieldInput = row.createEl(isLong ? 'textarea' : 'input', { cls: 'ai-agent-approval-field' });
        if (isLong) fieldInput.rows = 6;
        fieldInput.value =
          editableField === 'tags'
            ? (Array.isArray(args.tags) ? args.tags.join(', ') : '')
            : String(args[editableField] ?? '');
      } else {
        row.createDiv({ cls: 'ai-agent-approval-context', text: JSON.stringify(args) });
      }

      const btnRow = row.createDiv({ cls: 'ai-agent-approval-btns' });
      const approveBtn = btnRow.createEl('button', { text: 'Approve', cls: 'mod-cta' });
      const skipBtn = btnRow.createEl('button', { text: 'Skip' });
      const cleanup = (decision) => {
        approveBtn.disabled = true;
        skipBtn.disabled = true;
        if (fieldInput) fieldInput.disabled = true;
        row.addClass('ai-agent-approval-done');
        resolve(decision);
      };
      approveBtn.addEventListener('click', () => {
        let finalArgs = args;
        if (fieldInput) {
          finalArgs = { ...args };
          if (editableField === 'tags') {
            finalArgs.tags = fieldInput.value.split(',').map((t) => t.trim()).filter(Boolean);
          } else {
            finalArgs[editableField] = fieldInput.value;
          }
        }
        cleanup({ approved: true, args: finalArgs });
      });
      skipBtn.addEventListener('click', () => cleanup({ approved: false }));
      this.logEl.scrollTop = this.logEl.scrollHeight;
    });
  }

  logStep(type, text) {
    const row = this.logEl.createDiv({ cls: `ai-agent-step ai-agent-${type}` });
    row.setText(text);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return row;
  }

  async onClose() {}
}

module.exports = { AgentView };
