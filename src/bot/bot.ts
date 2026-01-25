import { Bot } from 'grammy';
import { config } from '../config.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import {
  handleStart,
  handleNew,
  handleProject,
  handleNewProject,
  handleStatus,
  handleMode,
} from './handlers/command.handler.js';
import { handleMessage } from './handlers/message.handler.js';

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Apply auth middleware to all updates
  bot.use(authMiddleware);

  // Bot command handlers
  bot.command('start', handleStart);
  bot.command('new', handleNew);
  bot.command('project', handleProject);
  bot.command('newproject', handleNewProject);
  bot.command('status', handleStatus);
  bot.command('mode', handleMode);

  // Handle regular text messages
  bot.on('message:text', handleMessage);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
