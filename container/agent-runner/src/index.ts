/**
 * NanoClaw Agent Runner (Abacus AI RouteLLM)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Uses Abacus AI RouteLLM (OpenAI-compatible API) with a custom agent loop
 * that executes tools locally inside the container.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChildProcess, spawn } from 'child_process';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionToolMessageParam } from 'openai/resources/chat/completions';
import { executeTool, TOOL_DEFINITIONS } from './tools.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  model?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_AGENT_TURNS = 50;
const CONVERSATION_FILE = '/workspace/group/.nanoclaw-conversation.json';
const ROUTELLM_BASE_URL = 'https://routellm.abacus.ai/v1';
const DEFAULT_MODEL = 'route-llm';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function buildSystemPrompt(containerInput: ContainerInput): string {
  const parts: string[] = [];

  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  parts.push(`You are an AI assistant running inside an isolated container.
Your working directory is /workspace/group.
You have tools available: bash, read_file, write_file, edit_file, list_directory, grep, glob, web_search, web_fetch.
You also have MCP tools prefixed with mcp__nanoclaw__ for sending messages, scheduling tasks, etc.
Use tools proactively to help the user. Think step by step, then act.`);

  return parts.join('\n\n---\n\n');
}

function loadConversation(): ChatCompletionMessageParam[] {
  try {
    if (fs.existsSync(CONVERSATION_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONVERSATION_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch {
    log('Failed to load conversation history, starting fresh');
  }
  return [];
}

function saveConversation(messages: ChatCompletionMessageParam[]): void {
  try {
    const maxMessages = 200;
    const trimmed = messages.length > maxMessages
      ? messages.slice(messages.length - maxMessages)
      : messages;
    fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    log(`Failed to save conversation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildMcpToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'mcp__nanoclaw__send_message',
        description: 'Send a message to the user or group immediately while you are still running. Use for progress updates or to send multiple messages.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message text to send' },
            sender: { type: 'string', description: 'Your role/identity name (optional)' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp__nanoclaw__schedule_task',
        description: 'Schedule a recurring or one-time task. The task will run as a full agent.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What the agent should do when the task runs' },
            schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'Schedule type' },
            schedule_value: { type: 'string', description: 'cron expression, interval ms, or local timestamp' },
            context_mode: { type: 'string', enum: ['group', 'isolated'], description: 'group=with history, isolated=fresh' },
          },
          required: ['prompt', 'schedule_type', 'schedule_value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp__nanoclaw__list_tasks',
        description: 'List all scheduled tasks.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp__nanoclaw__cancel_task',
        description: 'Cancel a scheduled task.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task ID to cancel' },
          },
          required: ['task_id'],
        },
      },
    },
  ];
}

function writeMcpIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  containerInput: ContainerInput,
): Promise<string> {
  const IPC_DIR = '/workspace/ipc';
  const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
  const TASKS_DIR = path.join(IPC_DIR, 'tasks');

  if (name === 'mcp__nanoclaw__send_message') {
    const data = {
      type: 'message',
      chatJid: containerInput.chatJid,
      text: args.text as string,
      sender: args.sender || undefined,
      groupFolder: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeMcpIpcFile(MESSAGES_DIR, data);
    return 'Message sent.';
  }

  if (name === 'mcp__nanoclaw__schedule_task') {
    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid: containerInput.chatJid,
      createdBy: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    };
    const filename = writeMcpIpcFile(TASKS_DIR, data);
    return `Task scheduled (${filename})`;
  }

  if (name === 'mcp__nanoclaw__list_tasks') {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
    if (!fs.existsSync(tasksFile)) return 'No scheduled tasks found.';
    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = containerInput.isMain
      ? allTasks
      : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === containerInput.groupFolder);
    if (tasks.length === 0) return 'No scheduled tasks found.';
    return tasks
      .map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string }) =>
        `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}`)
      .join('\n');
  }

  if (name === 'mcp__nanoclaw__cancel_task') {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder: containerInput.groupFolder,
      isMain: containerInput.isMain,
      timestamp: new Date().toISOString(),
    };
    writeMcpIpcFile(TASKS_DIR, data);
    return `Task ${args.task_id} cancellation requested.`;
  }

  return `Unknown MCP tool: ${name}`;
}

async function runQuery(
  prompt: string,
  containerInput: ContainerInput,
  client: OpenAI,
  conversationHistory: ChatCompletionMessageParam[],
  systemPrompt: string,
): Promise<{ result: string | null; closedDuringQuery: boolean }> {
  conversationHistory.push({ role: 'user', content: prompt });

  const allTools = [...TOOL_DEFINITIONS, ...buildMcpToolDefinitions()];
  const model = containerInput.model || DEFAULT_MODEL;

  let closedDuringQuery = false;
  let lastAssistantText: string | null = null;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    if (shouldClose()) {
      closedDuringQuery = true;
      break;
    }

    const ipcMessages = drainIpcInput();
    for (const text of ipcMessages) {
      log(`Piping IPC message into conversation (${text.length} chars)`);
      conversationHistory.push({ role: 'user', content: text });
    }

    log(`Turn ${turn + 1}: calling ${model} (${conversationHistory.length} messages)...`);

    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
        ],
        tools: allTools,
        tool_choice: 'auto',
        max_tokens: 8192,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`API error: ${errMsg}`);
      return { result: `Error calling Abacus AI: ${errMsg}`, closedDuringQuery: false };
    }

    const choice = response.choices[0];
    if (!choice) {
      log('No choices in response');
      break;
    }

    const message = choice.message;
    conversationHistory.push(message as ChatCompletionMessageParam);

    if (message.content) {
      lastAssistantText = message.content;
      log(`Assistant text (${message.content.length} chars): ${message.content.slice(0, 200)}`);
    }

    if (choice.finish_reason === 'stop' || !message.tool_calls || message.tool_calls.length === 0) {
      log(`Finished: reason=${choice.finish_reason}`);
      break;
    }

    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs: Record<string, unknown>;
      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        fnArgs = {};
      }

      log(`Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);

      let result: string;
      if (fnName.startsWith('mcp__nanoclaw__')) {
        result = await executeMcpTool(fnName, fnArgs, containerInput);
      } else {
        result = await executeTool(fnName, fnArgs);
      }

      log(`Tool result (${result.length} chars): ${result.slice(0, 200)}`);

      const toolMsg: ChatCompletionToolMessageParam = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      };
      conversationHistory.push(toolMsg);
    }
  }

  saveConversation(conversationHistory);
  return { result: lastAssistantText, closedDuringQuery };
}

function archiveConversation(messages: ChatCompletionMessageParam[], assistantName?: string): void {
  try {
    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const time = new Date();
    const name = `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const lines: string[] = [];
    lines.push(`# Conversation`);
    lines.push('');
    lines.push(`Archived: ${time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
        lines.push(`**User**: ${content}`);
        lines.push('');
      } else if (msg.role === 'assistant' && typeof (msg as { content?: string }).content === 'string') {
        const text = (msg as { content: string }).content;
        const content = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
        lines.push(`**${assistantName || 'Assistant'}**: ${content}`);
        lines.push('');
      }
    }

    fs.writeFileSync(filePath, lines.join('\n'));
    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const apiKey = containerInput.secrets?.['ABACUS_AI_API_KEY']
    || containerInput.secrets?.['ANTHROPIC_API_KEY']
    || process.env.ABACUS_AI_API_KEY;

  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'ABACUS_AI_API_KEY not found in secrets or environment' });
    process.exit(1);
  }

  const client = new OpenAI({
    baseURL: ROUTELLM_BASE_URL,
    apiKey,
  });

  const systemPrompt = buildSystemPrompt(containerInput);
  let conversationHistory = containerInput.sessionId ? loadConversation() : [];

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      log(`Starting query (history: ${conversationHistory.length} messages)...`);

      const queryResult = await runQuery(prompt, containerInput, client, conversationHistory, systemPrompt);

      writeOutput({
        status: 'success',
        result: queryResult.result,
        newSessionId: containerInput.sessionId || 'abacus-session',
      });

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }

  archiveConversation(conversationHistory, containerInput.assistantName);
}

main();
