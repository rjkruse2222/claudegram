/**
 * MCP tool definitions for Claudegram.
 *
 * Exposes Reddit, Medium, and media-extraction capabilities as MCP tools
 * so the Claude agent can invoke them directly during a conversation.
 */

import { z } from 'zod/v4';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { redditFetch } from '../reddit/redditfetch.js';
import { fetchMediumArticle, isMediumUrl } from '../medium/freedium.js';
import { extractMedia, cleanupExtractResult, type ExtractMode, type ExtractResult } from '../media/extract.js';
import { messageSender } from '../telegram/message-sender.js';

interface McpServerOptions {
  telegramCtx: Context;
  sessionKey: string;
}

export function createClaudegramMcpServer(options: McpServerOptions): McpSdkServerConfigWithInstance {
  const tools: SdkMcpToolDefinition<any>[] = [];

  // ── Reddit tool ────────────────────────────────────────────────────
  if (config.REDDIT_ENABLED) {
    tools.push(
      tool(
        'claudegram_fetch_reddit',
        'Fetch Reddit content: subreddit listings, post with comments, or user profiles. ' +
          'Accepts targets like r/subreddit, u/username, post URLs, or bare post IDs.',
        {
          target: z.string().describe('Reddit target: r/<subreddit>, u/<username>, post URL, or post ID'),
          sort: z.string().optional().describe('Sort order: hot, new, top, rising (default: hot)'),
          time_filter: z.string().optional().describe('Time filter for top sort: hour, day, week, month, year, all'),
          limit: z.number().optional().describe('Number of posts to fetch (default: 10)'),
          depth: z.number().optional().describe('Comment depth for posts (default: 5)'),
        },
        async (args) => {
          try {
            const result = await redditFetch([args.target], {
              sort: args.sort,
              limit: args.limit ?? config.REDDITFETCH_DEFAULT_LIMIT,
              depth: args.depth ?? config.REDDITFETCH_DEFAULT_DEPTH,
              timeFilter: args.time_filter,
            });

            // Truncate very large results to avoid blowing context
            const truncated = result.length > 30_000
              ? result.slice(0, 30_000) + '\n\n[... truncated — full output exceeded 30k chars]'
              : result;

            return { content: [{ type: 'text' as const, text: truncated }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text' as const, text: `Reddit fetch failed: ${msg}` }], isError: true };
          }
        },
      ),
    );
  }

  // ── Medium tool ────────────────────────────────────────────────────
  if (config.MEDIUM_ENABLED) {
    tools.push(
      tool(
        'claudegram_fetch_medium',
        'Fetch a Medium article via Freedium, bypassing the paywall. Returns the article as Markdown.',
        {
          url: z.string().describe('Medium article URL'),
        },
        async (args) => {
          try {
            if (!isMediumUrl(args.url)) {
              return {
                content: [{ type: 'text' as const, text: 'The provided URL does not appear to be a Medium article.' }],
                isError: true,
              };
            }

            const article = await fetchMediumArticle(args.url);

            const header = `# ${article.title}\n*By ${article.author}*\n\n`;
            const body = article.markdown;
            const full = header + body;

            const truncated = full.length > 30_000
              ? full.slice(0, 30_000) + '\n\n[... truncated — full article exceeded 30k chars]'
              : full;

            return { content: [{ type: 'text' as const, text: truncated }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text' as const, text: `Medium fetch failed: ${msg}` }], isError: true };
          }
        },
      ),
    );
  }

  // ── Media extraction tool ──────────────────────────────────────────
  if (config.EXTRACT_ENABLED) {
    tools.push(
      tool(
        'claudegram_extract_media',
        'Extract content from YouTube, Instagram, or TikTok URLs. ' +
          'Use mode "text" to transcribe, "audio" for MP3, "video" for MP4, "all" for everything. ' +
          'Audio and video files are sent to the user via Telegram as a side-effect.',
        {
          url: z.string().describe('YouTube, Instagram, or TikTok URL'),
          mode: z.enum(['text', 'audio', 'video', 'all']).describe('Extraction mode'),
        },
        async (args) => {
          let result: ExtractResult | undefined;
          try {
            result = await extractMedia({
              url: args.url,
              mode: args.mode as ExtractMode,
            });

            const parts: string[] = [];
            parts.push(`**${result.title}** (${result.platform})`);
            if (result.duration) {
              parts.push(`Duration: ${Math.round(result.duration)}s`);
            }

            // Send media files to Telegram if available
            const ctx = options.telegramCtx;
            if (result.audioPath) {
              try {
                await messageSender.sendDocument(ctx, result.audioPath, `🎧 ${result.title}.mp3`);
                parts.push('Audio file sent to chat.');
              } catch {
                parts.push('Failed to send audio file.');
              }
            }
            if (result.videoPath) {
              try {
                await messageSender.sendDocument(ctx, result.videoPath, `🎬 ${result.title}.mp4`);
                parts.push('Video file sent to chat.');
              } catch {
                parts.push('Failed to send video file.');
              }
            }

            if (result.transcript) {
              parts.push('\n---\n**Transcript:**\n' + result.transcript);
            }

            if (result.warnings.length > 0) {
              parts.push('\nWarnings: ' + result.warnings.join('; '));
            }

            const text = parts.join('\n');
            const truncated = text.length > 30_000
              ? text.slice(0, 30_000) + '\n\n[... truncated]'
              : text;

            return { content: [{ type: 'text' as const, text: truncated }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text' as const, text: `Extract failed: ${msg}` }], isError: true };
          } finally {
            if (result) {
              cleanupExtractResult(result);
            }
          }
        },
      ),
    );
  }

  return createSdkMcpServer({
    name: 'claudegram-tools',
    version: '1.0.0',
    tools,
  });
}
