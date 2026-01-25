import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { sessionManager } from './session-manager.js';

interface AgentResponse {
  text: string;
  toolsUsed: string[];
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentOptions {
  onProgress?: (text: string) => void;
  abortController?: AbortController;
  command?: string;
  model?: string;
}

const conversationHistory: Map<number, ConversationMessage[]> = new Map();

// Track current model per chat (default: sonnet)
const chatModels: Map<number, string> = new Map();

const SYSTEM_PROMPT = `You are Claude, an AI assistant helping via Telegram.

Guidelines:
- Be concise - responses appear on a phone screen
- When asked to do tasks, do them directly without asking for confirmation
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly`;

export async function sendToAgent(
  chatId: number,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, abortController, command, model } = options;

  const session = sessionManager.getSession(chatId);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  sessionManager.updateActivity(chatId);

  // Get or initialize conversation history
  let history = conversationHistory.get(chatId) || [];

  // Determine the prompt based on command
  let prompt = message;
  if (command === 'explore') {
    prompt = `Explore the codebase and answer: ${message}`;
  }

  // Add user message to history
  history.push({
    role: 'user',
    content: prompt,
  });

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;

  // Determine permission mode based on command
  const permissionMode = command === 'plan' ? 'plan' : 'acceptEdits';

  // Determine model to use
  const effectiveModel = model || chatModels.get(chatId) || undefined;

  try {
    const controller = abortController || new AbortController();

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd: session.workingDirectory,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
      permissionMode,
      abortController: controller,
      pathToClaudeCodeExecutable: '/Users/nacho/.local/bin/claude',
      stderr: (data: string) => {
        console.error('[Claude stderr]:', data);
      },
    };

    // Add model if specified
    if (effectiveModel) {
      (queryOptions as Record<string, unknown>).model = effectiveModel;
    }

    const response = await query({
      prompt,
      options: queryOptions,
    });

    // Process response messages
    for await (const responseMessage of response) {
      // Check for abort
      if (controller.signal.aborted) {
        fullText = '🛑 Request cancelled.';
        break;
      }

      console.log('[Claude] Message type:', responseMessage.type);

      if (responseMessage.type === 'assistant') {
        console.log('[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          console.log('[Claude] Block type:', block.type);
          if (block.type === 'text') {
            fullText += block.text;
            onProgress?.(fullText);
          } else if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
          }
        }
      } else if (responseMessage.type === 'result') {
        console.log('[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;
        if (responseMessage.subtype === 'success') {
          // Append final result text if different from accumulated
          if (responseMessage.result && !fullText.includes(responseMessage.result)) {
            if (fullText.length > 0) {
              fullText += '\n\n';
            }
            fullText += responseMessage.result;
            onProgress?.(fullText);
          }
        } else {
          // error_max_turns or error_during_execution
          fullText = `Error: ${responseMessage.subtype}`;
          onProgress?.(fullText);
        }
      }
    }
  } catch (error) {
    // If aborted, return cancellation message
    if (abortController?.signal.aborted) {
      return {
        text: '🛑 Request cancelled.',
        toolsUsed,
      };
    }

    // If we got a result, ignore process exit errors (SDK quirk)
    if (gotResult && error instanceof Error && error.message.includes('exited with code')) {
      console.log('[Claude] Ignoring exit code error after successful result');
    } else {
      console.error('[Claude] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Claude error: ${errorMessage}`);
    }
  }

  // Add assistant response to history
  if (fullText && !abortController?.signal.aborted) {
    history.push({
      role: 'assistant',
      content: fullText,
    });
  }

  conversationHistory.set(chatId, history);

  return {
    text: fullText || 'No response from Claude.',
    toolsUsed,
  };
}

export function clearConversation(chatId: number): void {
  conversationHistory.delete(chatId);
}

export function setModel(chatId: number, model: string): void {
  chatModels.set(chatId, model);
}

export function getModel(chatId: number): string {
  return chatModels.get(chatId) || 'sonnet';
}

export function clearModel(chatId: number): void {
  chatModels.delete(chatId);
}
