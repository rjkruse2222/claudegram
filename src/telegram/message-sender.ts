import { Context, Api } from 'grammy';
import { config } from '../config.js';
import { splitMessage } from './markdown.js';

interface StreamState {
  messageId: number | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
  typingInterval: NodeJS.Timeout | null;
}

const TYPING_INTERVAL_MS = 4000; // Send typing every 4 seconds

export class MessageSender {
  private streamStates: Map<number, StreamState> = new Map();

  async sendMessage(ctx: Context, text: string): Promise<void> {
    const parts = splitMessage(text, config.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      await ctx.reply(part, { parse_mode: undefined });
    }
  }

  async startStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const message = await ctx.reply('▌');

    // Start continuous typing indicator
    const typingInterval = this.startTypingIndicator(ctx.api, chatId);

    this.streamStates.set(chatId, {
      messageId: message.message_id,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      typingInterval,
    });
  }

  private startTypingIndicator(api: Api, chatId: number): NodeJS.Timeout {
    // Send typing immediately
    api.sendChatAction(chatId, 'typing').catch(() => {});

    // Then send every TYPING_INTERVAL_MS
    return setInterval(() => {
      api.sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private stopTypingIndicator(state: StreamState): void {
    if (state.typingInterval) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }

  async updateStream(ctx: Context, content: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);
    if (!state || !state.messageId) return;

    state.content = content;

    if (state.updateScheduled) return;

    const timeSinceLastUpdate = Date.now() - state.lastUpdate;

    if (timeSinceLastUpdate >= config.STREAMING_DEBOUNCE_MS) {
      await this.flushUpdate(ctx, state);
    } else {
      state.updateScheduled = true;
      setTimeout(async () => {
        state.updateScheduled = false;
        await this.flushUpdate(ctx, state);
      }, config.STREAMING_DEBOUNCE_MS - timeSinceLastUpdate);
    }
  }

  private async flushUpdate(ctx: Context, state: StreamState): Promise<void> {
    if (!state.messageId) return;

    const displayContent = state.content.length > 0
      ? state.content.substring(0, config.MAX_MESSAGE_LENGTH - 1) + '▌'
      : '▌';

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        state.messageId,
        displayContent,
        { parse_mode: undefined }
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      // Ignore "message not modified" errors
      if (error instanceof Error && !error.message.includes('message is not modified')) {
        console.error('Error updating stream:', error);
      }
    }
  }

  async finishStreaming(ctx: Context, finalContent: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);

    if (state) {
      // Stop typing indicator
      this.stopTypingIndicator(state);

      if (state.messageId) {
        const parts = splitMessage(finalContent, config.MAX_MESSAGE_LENGTH);

        try {
          // Update the first message with first part
          await ctx.api.editMessageText(
            chatId,
            state.messageId,
            parts[0] || 'Done.',
            { parse_mode: undefined }
          );

          // Send additional messages for remaining parts
          for (let i = 1; i < parts.length; i++) {
            await ctx.reply(parts[i], { parse_mode: undefined });
          }
        } catch (error) {
          console.error('Error finishing stream:', error);
        }
      }
    }

    this.streamStates.delete(chatId);
  }

  async cancelStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);
    if (state) {
      // Stop typing indicator
      this.stopTypingIndicator(state);

      if (state.messageId) {
        try {
          await ctx.api.editMessageText(
            chatId,
            state.messageId,
            '⚠️ Request cancelled',
            { parse_mode: undefined }
          );
        } catch (error) {
          console.error('Error cancelling stream:', error);
        }
      }
    }

    this.streamStates.delete(chatId);
  }

  // Send typing indicator for a specific chat (useful for long operations)
  async sendTyping(ctx: Context): Promise<void> {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
    } catch (error) {
      console.error('Error sending typing:', error);
    }
  }
}

export const messageSender = new MessageSender();
