import { Context } from 'grammy';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { config } from '../../config.js';

export async function handleMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;

  if (!chatId || !text) return;

  // Check for active session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set.\n\nUse `/project <name>` to open a project first.'
    );
    return;
  }

  try {
    if (config.STREAMING_MODE === 'streaming') {
      await handleStreamingResponse(ctx, chatId, text);
    } else {
      await handleWaitResponse(ctx, chatId, text);
    }
  } catch (error) {
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

  try {
    const response = await sendToAgent(chatId, message, (progressText) => {
      messageSender.updateStream(ctx, progressText);
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

  const response = await sendToAgent(chatId, message);
  await messageSender.sendMessage(ctx, response.text);
}
