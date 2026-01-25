import { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId) {
    console.log('Rejected: No user ID in context');
    return;
  }

  if (!config.ALLOWED_USER_IDS.includes(userId)) {
    console.log(`Rejected: Unauthorized user ${userId}`);
    await ctx.reply('⛔ You are not authorized to use this bot.');
    return;
  }

  await next();
}
