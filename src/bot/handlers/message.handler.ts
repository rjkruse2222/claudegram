import { Context } from 'grammy';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { config } from '../../config.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { isClaudeCommand, parseClaudeCommand } from '../../claude/command-parser.js';

export async function handleMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;

  if (!chatId || !text || !messageId || !messageDate) return;

  // Filter stale messages (sent before bot started)
  if (isStaleMessage(messageDate)) {
    console.log(`[Message] Ignoring stale message ${messageId} from before bot start`);
    return;
  }

  // Check for duplicate messages (Telegram retries)
  if (isDuplicate(messageId)) {
    console.log(`[Message] Ignoring duplicate message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Skip if this is a Claude command (handled by command handler)
  if (isClaudeCommand(text)) {
    return;
  }

  // Check for active session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set.\n\nUse `/project <name>` to open a project first.'
    );
    return;
  }

  // Check if already processing - show queue position
  if (isProcessing(chatId)) {
    const position = getQueuePosition(chatId) + 1;
    await ctx.reply(`⏳ Queued (position ${position})`);
  }

  try {
    // Queue the request - process one at a time per chat
    await queueRequest(chatId, text, async () => {
      if (config.STREAMING_MODE === 'streaming') {
        await handleStreamingResponse(ctx, chatId, text);
      } else {
        await handleWaitResponse(ctx, chatId, text);
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error handling message:', error);
    await ctx.reply(`❌ Error: ${errorMessage}`);
  }
}

async function handleStreamingResponse(
  ctx: Context,
  chatId: number,
  message: string
): Promise<void> {
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(chatId, abortController);

  try {
    const response = await sendToAgent(chatId, message, {
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
}

async function handleWaitResponse(
  ctx: Context,
  chatId: number,
  message: string
): Promise<void> {
  // Send typing indicator
  await ctx.replyWithChatAction('typing');

  const abortController = new AbortController();
  setAbortController(chatId, abortController);

  const response = await sendToAgent(chatId, message, { abortController });
  await messageSender.sendMessage(ctx, response.text);
}
