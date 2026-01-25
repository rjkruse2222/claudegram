import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../claude/agent.js';
import { config } from '../../config.js';
import * as fs from 'fs';
import * as path from 'path';

export async function handleStart(ctx: Context): Promise<void> {
  const welcomeMessage = `👋 Welcome to Claudegram!

I bridge your messages to Claude Code running on your local machine.

**Getting Started:**
1. Set your project directory with \`/project /path/to/project\`
2. Start chatting with Claude about your code!

**Commands:**
• \`/project <name>\` - Open a project
• \`/newproject <name>\` - Create a new project
• \`/new\` - Clear session and start fresh
• \`/status\` - Show current session info

Current mode: ${config.STREAMING_MODE}`;

  await ctx.reply(welcomeMessage);
}

export async function handleNew(ctx: Context): Promise<void> {
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

  const status = `📊 **Session Status**

• **Working Directory:** \`${session.workingDirectory}\`
• **Session ID:** \`${session.conversationId}\`
• **Created:** ${session.createdAt.toLocaleString()}
• **Last Activity:** ${session.lastActivity.toLocaleString()}
• **Mode:** ${config.STREAMING_MODE}`;

  await ctx.reply(status);
}

export async function handleMode(ctx: Context): Promise<void> {
  const mode = config.STREAMING_MODE === 'streaming'
    ? '🔄 **Streaming Mode**\n\nResponses update progressively as Claude types.'
    : '⏳ **Wait Mode**\n\nResponses appear only when complete.';

  await ctx.reply(mode);
}
