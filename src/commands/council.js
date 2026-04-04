/**
 * Council Pattern Commands
 *
 * Multi-agent debate system. Generates structured perspectives on decisions.
 * The calling AI tool processes the debate framework inline.
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import boxen from 'boxen';
import { loadIdentity } from './identity.js';

// ── Agent Prompt Templates ──────────────────────────────────────────────────

const AGENT_PROMPTS = {
  bull: {
    name: 'Bull',
    icon: '🟢',
    system: 'You are the Bull — an optimistic strategic advisor. Argue the strongest case FOR the proposition. Focus on upside potential, market timing, competitive advantages, and momentum. Be specific about WHY this is a good bet. Back claims with reasoning.',
  },
  bear: {
    name: 'Bear',
    icon: '🔴',
    system: 'You are the Bear — a skeptical risk analyst. Argue the strongest case AGAINST the proposition. Focus on risks, competition, execution challenges, opportunity costs, and what could go wrong. Be specific about failure modes. Do not hedge — be direct.',
  },
  pragmatist: {
    name: 'Pragmatist',
    icon: '🔵',
    system: 'You are the Pragmatist — a practical advisor focused on execution. Cut through the bull/bear debate. What is the most practical path forward given real constraints (time, money, skills, energy)? Focus on what can actually be shipped and when.',
  },
  risk: {
    name: 'Risk Analyst',
    icon: '🟡',
    system: 'You are the Risk Analyst — focused on probability and expected value. Assign rough probability estimates to outcomes. Calculate expected value. Identify the key assumptions that, if wrong, change everything. Be quantitative where possible.',
  },
  advocate: {
    name: 'Advocate',
    icon: '🟢',
    system: 'You are the Advocate — defending the idea with full conviction. Present the strongest possible case. Address anticipated objections proactively. Show why this idea deserves commitment.',
  },
  critic: {
    name: 'Critic',
    icon: '🔴',
    system: 'You are the Critic — stress-testing every assumption. Find the weakest points. Ask the questions nobody wants to ask. Identify hidden dependencies and unstated assumptions.',
  },
  auditor: {
    name: 'Auditor',
    icon: '🟡',
    system: 'You are the Auditor — checking for completeness and correctness. Is anything missing from the analysis? Are there compliance, security, or legal risks? What has been overlooked?',
  },
  physicist: {
    name: 'First Principles (Physics)',
    icon: '⚛️',
    system: 'You reason from first principles like a physicist. Strip away all assumptions, conventions, and "best practices." What are the fundamental truths? What would you build if you started from scratch with no existing solutions?',
  },
  economist: {
    name: 'First Principles (Economics)',
    icon: '📊',
    system: 'You reason from economic first principles. What are the incentive structures? Who pays, who benefits? What are the supply/demand dynamics? Where is value actually created vs. captured? Follow the money.',
  },
  builder: {
    name: 'Builder',
    icon: '🔨',
    system: 'You are the Builder — focused on what can actually be built. What is the simplest version that delivers value? What are the technical constraints? What is the build vs. buy tradeoff? Estimate effort honestly.',
  },
  user: {
    name: 'User Perspective',
    icon: '👤',
    system: 'You represent the end user. What do users actually want? What friction points exist? Would a real person pay for this and use it regularly? Be brutally honest about user experience.',
  },
  investor: {
    name: 'Investor',
    icon: '💰',
    system: 'You are an investor evaluating this opportunity. What is the market size? What is the competitive moat? What are the unit economics? What would make you write a check — or walk away?',
  },
};

const MODE_AGENTS = {
  debate: ['bull', 'bear', 'pragmatist'],
  red_team: ['advocate', 'critic', 'auditor'],
  first_principles: ['physicist', 'economist', 'builder'],
  product: ['user', 'builder', 'investor'],
};

// ── Core council function (used by MCP + CLI) ───────────────────────────────

export async function runCouncil(question, options = {}) {
  const mode = options.mode || 'debate';
  const agentKeys = options.agents || MODE_AGENTS[mode] || MODE_AGENTS.debate;

  // Load user identity for context
  let identityContext = '';
  try {
    const identity = await loadIdentity('all');
    const parts = [];
    if (identity.mission?.statement) parts.push(`Mission: ${identity.mission.statement}`);
    if (identity.goals?.goals?.length) {
      parts.push('Current goals: ' + identity.goals.goals.filter(g => g.status === 'active').map(g => `[P${g.priority}] ${g.text}`).join('; '));
    }
    if (identity.projects?.projects?.length) {
      parts.push('Active projects: ' + identity.projects.projects.filter(p => p.status === 'active').map(p => `${p.name}${p.stack ? ` (${p.stack})` : ''}`).join('; '));
    }
    if (identity.preferences?.preferences?.length) {
      parts.push('Preferences: ' + identity.preferences.preferences.map(p => `${p.key}: ${p.value}`).join('; '));
    }
    if (parts.length > 0) {
      identityContext = '\n\nUser context:\n' + parts.join('\n');
    }
  } catch {
    // Identity not configured, proceed without it
  }

  // Build structured debate output
  const agents = agentKeys.map(key => {
    const agent = AGENT_PROMPTS[key];
    if (!agent) return { key, name: key, icon: '●', system: `You are the ${key} perspective. Analyze from this viewpoint.` };
    return { key, ...agent };
  });

  const debate = {
    question,
    mode,
    agents: agents.map(a => ({
      key: a.key,
      name: a.name,
      icon: a.icon,
      prompt: a.system + identityContext + '\n\nQuestion: ' + question,
    })),
    instructions: `Analyze this question from each agent's perspective. For each agent, provide a focused 2-3 paragraph analysis. Then synthesize into a clear recommendation.`,
  };

  return debate;
}

// ── CLI Commands ────────────────────────────────────────────────────────────

export async function councilCommand(question, options = {}) {
  if (!question) {
    console.error(chalk.red('\n✖ Usage: memoir council "your question here" [--mode debate|red_team|first_principles|product]'));
    return;
  }

  const debate = await runCouncil(question, options);

  const parts = [
    chalk.cyan.bold('Council Debate'),
    chalk.gray(`Mode: ${debate.mode}`),
    '',
    chalk.white.bold(`Question: ${debate.question}`),
    '',
    chalk.gray('─'.repeat(60)),
  ];

  for (const agent of debate.agents) {
    parts.push('');
    parts.push(`${agent.icon} ${chalk.white.bold(agent.name)}`);
    parts.push(chalk.gray('  Perspective prompt:'));
    // Show a brief version of the prompt
    const briefPrompt = agent.prompt.split('\n')[0];
    parts.push(chalk.gray(`  ${briefPrompt.slice(0, 100)}...`));
  }

  parts.push('');
  parts.push(chalk.gray('─'.repeat(60)));
  parts.push('');
  parts.push(chalk.white(debate.instructions));

  console.log('\n' + boxen(parts.join('\n'), {
    padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true
  }) + '\n');

  console.log(chalk.gray('  Tip: Use this via MCP in any AI tool for the AI to run the full debate.\n'));
}
