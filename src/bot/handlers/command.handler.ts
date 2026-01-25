import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import {
  clearConversation,
  sendToAgent,
  sendLoopToAgent,
  setModel,
  getModel,
  isDangerousMode,
} from '../../claude/agent.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import {
  cancelRequest,
  clearQueue,
  isProcessing,
  queueRequest,
  setAbortController,
} from '../../claude/request-queue.js';
import * as fs from 'fs';
import * as path from 'path';

export async function handleStart(ctx: Context): Promise<void> {
  const dangerousWarning = isDangerousMode()
    ? '\n\n⚠️ **DANGEROUS MODE ENABLED** - All tool permissions auto-approved'
    : '';

  const welcomeMessage = `👋 Welcome to Claudegram!

I bridge your messages to Claude Code running on your local machine.

**Getting Started:**
1. Set your project directory with \`/project /path/to/project\`
2. Start chatting with Claude about your code!

**Commands:**
• \`/project <name>\` - Open a project
• \`/newproject <name>\` - Create a new project
• \`/clear\` - Clear session and start fresh
• \`/status\` - Show current session info
• \`/commands\` - Show all available commands

Current mode: ${config.STREAMING_MODE}${dangerousWarning}`;

  await ctx.reply(welcomeMessage);
}

export async function handleClear(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  sessionManager.clearSession(chatId);
  clearConversation(chatId);

  await ctx.reply('🔄 Session cleared. Use /project to set a new working directory.');
}

export async function handleProject(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    const session = sessionManager.getSession(chatId);
    if (session) {
      await ctx.reply(`📁 Current project: \`${session.workingDirectory}\``);
    } else {
      // List available projects
      const projects = listProjects();
      if (projects.length > 0) {
        const list = projects.slice(0, 20).map(p => `• ${p}`).join('\n');
        await ctx.reply(`Usage: \`/project <name>\`\n\n**Available projects:**\n${list}`);
      } else {
        await ctx.reply('Usage: `/project <name>`\n\nNo projects found in workspace.');
      }
    }
    return;
  }

  // If it's a full path (starts with / or ~), use it directly
  let projectPath: string;
  if (args.startsWith('/') || args.startsWith('~')) {
    projectPath = args;
    if (projectPath.startsWith('~')) {
      projectPath = path.join(process.env.HOME || '', projectPath.slice(1));
    }
    projectPath = path.resolve(projectPath);
  } else {
    // Otherwise, treat as project name in workspace
    projectPath = path.join(config.WORKSPACE_DIR, args);
  }

  // Check if directory exists
  if (!fs.existsSync(projectPath)) {
    await ctx.reply(
      `📁 Project "${args}" doesn't exist.\n\nCreate it? Use: \`/newproject ${args}\``
    );
    return;
  }

  if (!fs.statSync(projectPath).isDirectory()) {
    await ctx.reply(`❌ Path is not a directory: \`${projectPath}\``);
    return;
  }

  sessionManager.setWorkingDirectory(chatId, projectPath);
  clearConversation(chatId);

  await ctx.reply(`✅ Project: **${args}**\n\nYou can now chat with Claude about this project!`);
}

export async function handleNewProject(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply('Usage: `/newproject <name>`');
    return;
  }

  // Sanitize project name (alphanumeric, dash, underscore only)
  if (!/^[a-zA-Z0-9_-]+$/.test(args)) {
    await ctx.reply('❌ Project name can only contain letters, numbers, dashes and underscores.');
    return;
  }

  const projectPath = path.join(config.WORKSPACE_DIR, args);

  if (fs.existsSync(projectPath)) {
    await ctx.reply(`❌ Project "${args}" already exists. Use \`/project ${args}\` to open it.`);
    return;
  }

  // Create the directory
  fs.mkdirSync(projectPath, { recursive: true });

  sessionManager.setWorkingDirectory(chatId, projectPath);
  clearConversation(chatId);

  await ctx.reply(`✅ Created and opened: **${args}**\n\nYou can now chat with Claude about this project!`);
}

function listProjects(): string[] {
  try {
    const entries = fs.readdirSync(config.WORKSPACE_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);

  if (!session) {
    await ctx.reply('ℹ️ No active session.\n\nUse `/project /path/to/project` to get started.');
    return;
  }

  const currentModel = getModel(chatId);
  const dangerousMode = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';

  const status = `📊 **Session Status**

• **Working Directory:** \`${session.workingDirectory}\`
• **Session ID:** \`${session.conversationId}\`
• **Model:** ${currentModel}
• **Created:** ${session.createdAt.toLocaleString()}
• **Last Activity:** ${session.lastActivity.toLocaleString()}
• **Mode:** ${config.STREAMING_MODE}
• **Dangerous Mode:** ${dangerousMode}
• **Uptime:** ${getUptimeFormatted()}`;

  await ctx.reply(status);
}

export async function handleMode(ctx: Context): Promise<void> {
  const mode = config.STREAMING_MODE === 'streaming'
    ? '🔄 **Streaming Mode**\n\nResponses update progressively as Claude types.'
    : '⏳ **Wait Mode**\n\nResponses appear only when complete.';

  await ctx.reply(mode);
}

// New commands

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await ctx.reply(`🏓 Pong!\n\nUptime: ${uptime}`);
}

export async function handleCancel(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const wasProcessing = isProcessing(chatId);
  const cancelled = cancelRequest(chatId);
  const clearedCount = clearQueue(chatId);

  if (cancelled || clearedCount > 0) {
    let message = '🛑 Cancelled.';
    if (clearedCount > 0) {
      message += ` (${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared)`;
    }
    await ctx.reply(message);
  } else if (!wasProcessing) {
    await ctx.reply('ℹ️ Nothing to cancel.');
  }
}

export async function handleCommands(ctx: Context): Promise<void> {
  await ctx.reply(getAvailableCommands());
}

export async function handleModelCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim().toLowerCase();

  const validModels = ['sonnet', 'opus', 'haiku'];

  if (!args) {
    const currentModel = getModel(chatId);
    await ctx.reply(
      `**Current model:** ${currentModel}\n\n` +
      `**Available models:**\n• sonnet (default)\n• opus\n• haiku\n\n` +
      `Use \`/model <name>\` to switch.`
    );
    return;
  }

  if (!validModels.includes(args)) {
    await ctx.reply(`❌ Unknown model "${args}".\n\nAvailable: ${validModels.join(', ')}`);
    return;
  }

  setModel(chatId, args);
  await ctx.reply(`✅ Model set to **${args}**`);
}

export async function handlePlan(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply('Usage: `/plan <task description>`\n\nEnters plan mode for complex tasks.');
    return;
  }

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply('⚠️ No project set.\n\nUse `/project <name>` to open a project first.');
    return;
  }

  // Queue the plan request
  try {
    await queueRequest(chatId, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'plan',
        });

        await messageSender.finishStreaming(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`❌ Error: ${errorMessage}`);
  }
}

export async function handleExplore(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const question = text.split(' ').slice(1).join(' ').trim();

  if (!question) {
    await ctx.reply('Usage: `/explore <question>`\n\nExplores the codebase to answer your question.');
    return;
  }

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply('⚠️ No project set.\n\nUse `/project <name>` to open a project first.');
    return;
  }

  // Queue the explore request
  try {
    await queueRequest(chatId, question, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, question, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'explore',
        });

        await messageSender.finishStreaming(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`❌ Error: ${errorMessage}`);
  }
}

// Session resume commands

export async function handleResume(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const history = sessionManager.getSessionHistory(chatId, 5);

  if (history.length === 0) {
    await ctx.reply('ℹ️ No session history found.\n\nUse `/project <name>` to start a new session.');
    return;
  }

  // Build inline keyboard with session options
  const keyboard = history.map((entry, index) => {
    const date = new Date(entry.lastActivity);
    const timeAgo = formatTimeAgo(date);
    const preview = entry.lastMessagePreview
      ? entry.lastMessagePreview.substring(0, 30) + (entry.lastMessagePreview.length > 30 ? '...' : '')
      : 'No messages';

    return [
      {
        text: `${entry.projectName} (${timeAgo})`,
        callback_data: `resume:${entry.conversationId}`,
      },
    ];
  });

  await ctx.reply('📜 **Recent Sessions**\n\nSelect a session to resume:', {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('resume:')) return;

  const conversationId = data.replace('resume:', '');
  const session = sessionManager.resumeSession(chatId, conversationId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }

  // Clear conversation history for fresh start with same project
  clearConversation(chatId);

  await ctx.answerCallbackQuery({ text: 'Session resumed!' });
  await ctx.editMessageText(
    `✅ Resumed session for **${path.basename(session.workingDirectory)}**\n\n` +
    `Working directory: \`${session.workingDirectory}\``
  );
}

export async function handleContinue(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.resumeLastSession(chatId);

  if (!session) {
    await ctx.reply('ℹ️ No previous session to continue.\n\nUse `/project <name>` to start a new session.');
    return;
  }

  // Clear conversation history for fresh start with same project
  clearConversation(chatId);

  await ctx.reply(
    `✅ Continuing **${path.basename(session.workingDirectory)}**\n\n` +
    `Working directory: \`${session.workingDirectory}\``
  );
}

// Loop mode command

export async function handleLoop(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `Usage: \`/loop <task>\`\n\n` +
      `Runs Claude iteratively until the task is complete (max ${config.MAX_LOOP_ITERATIONS} iterations).\n\n` +
      `Claude will say "DONE" when finished.`
    );
    return;
  }

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply('⚠️ No project set.\n\nUse `/project <name>` to open a project first.');
    return;
  }

  // Queue the loop request
  try {
    await queueRequest(chatId, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendLoopToAgent(chatId, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
        });

        await messageSender.finishStreaming(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`❌ Error: ${errorMessage}`);
  }
}

// Session listing command

export async function handleSessions(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const history = sessionManager.getSessionHistory(chatId, 10);
  const currentSession = sessionManager.getSession(chatId);

  if (history.length === 0 && !currentSession) {
    await ctx.reply('ℹ️ No sessions found.\n\nUse `/project <name>` to start a new session.');
    return;
  }

  let message = '📋 **Sessions**\n\n';

  if (currentSession) {
    message += `**Active:**\n• \`${path.basename(currentSession.workingDirectory)}\` (${formatTimeAgo(currentSession.lastActivity)})\n\n`;
  }

  if (history.length > 0) {
    message += '**Recent:**\n';
    for (const entry of history) {
      const isActive =
        currentSession && currentSession.conversationId === entry.conversationId;
      const marker = isActive ? '→ ' : '• ';
      const date = new Date(entry.lastActivity);
      message += `${marker}\`${entry.projectName}\` (${formatTimeAgo(date)})\n`;
    }
  }

  message += '\n_Use `/resume` to switch sessions or `/continue` to resume the last one._';

  await ctx.reply(message);
}

// Helper function

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
