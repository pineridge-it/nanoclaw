import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const SECRET_ENV_VARS = ['ABACUS_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const BASH_TIMEOUT = 300_000;
const MAX_OUTPUT = 100_000;

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[truncated ${text.length - max} chars]`;
}

function execAsync(command: string, options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, { ...options, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: (err && !stderr ? String(err) : stderr) || '',
      });
    });
  });
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'bash': return executeBash(args as { command: string });
    case 'read_file': return executeReadFile(args as { path: string; start_line?: number; end_line?: number });
    case 'write_file': return executeWriteFile(args as { path: string; content: string });
    case 'edit_file': return executeEditFile(args as { path: string; old_text: string; new_text: string });
    case 'list_directory': return executeListDirectory(args as { path: string });
    case 'grep': return executeGrep(args as { pattern: string; path?: string; include?: string });
    case 'glob': return executeGlob(args as { pattern: string; path?: string });
    case 'web_search': return executeWebSearch(args as { query: string });
    case 'web_fetch': return executeWebFetch(args as { url: string });
    default: return `Unknown tool: ${name}`;
  }
}

async function executeBash(args: { command: string }): Promise<string> {
  const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
  const { stdout, stderr } = await execAsync(unsetPrefix + args.command, {
    cwd: '/workspace/group',
    timeout: BASH_TIMEOUT,
  });
  const combined = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
  return truncate(combined) || '(no output)';
}

async function executeReadFile(args: { path: string; start_line?: number; end_line?: number }): Promise<string> {
  const filePath = resolvePath(args.path);
  if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const start = (args.start_line ?? 1) - 1;
  const end = args.end_line ?? lines.length;
  const slice = lines.slice(Math.max(0, start), end);
  const numbered = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
  return truncate(numbered);
}

async function executeWriteFile(args: { path: string; content: string }): Promise<string> {
  const filePath = resolvePath(args.path);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, args.content);
  return `File written: ${args.path} (${args.content.length} chars)`;
}

async function executeEditFile(args: { path: string; old_text: string; new_text: string }): Promise<string> {
  const filePath = resolvePath(args.path);
  if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
  const content = fs.readFileSync(filePath, 'utf-8');
  const idx = content.indexOf(args.old_text);
  if (idx === -1) return `Error: old_text not found in ${args.path}`;
  const newContent = content.slice(0, idx) + args.new_text + content.slice(idx + args.old_text.length);
  fs.writeFileSync(filePath, newContent);
  return `File edited: ${args.path}`;
}

async function executeListDirectory(args: { path: string }): Promise<string> {
  const dirPath = resolvePath(args.path || '.');
  if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${args.path}`;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const formatted = entries.map(e => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n');
  return truncate(formatted) || '(empty directory)';
}

async function executeGrep(args: { pattern: string; path?: string; include?: string }): Promise<string> {
  const searchPath = resolvePath(args.path || '.');
  let cmd = `grep -rn --color=never`;
  if (args.include) cmd += ` --include='${args.include}'`;
  cmd += ` '${args.pattern.replace(/'/g, "'\\''")}' '${searchPath}'`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
  if (!stdout.trim()) return stderr.trim() || 'No matches found.';
  return truncate(stdout.trim());
}

async function executeGlob(args: { pattern: string; path?: string }): Promise<string> {
  const searchPath = resolvePath(args.path || '.');
  const cmd = `find '${searchPath}' -name '${args.pattern.replace(/'/g, "'\\''")}' -type f 2>/dev/null | head -200`;
  const { stdout } = await execAsync(cmd, { timeout: 15_000 });
  return truncate(stdout.trim()) || 'No files found.';
}

async function executeWebSearch(args: { query: string }): Promise<string> {
  const cmd = `curl -sS 'https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(args.query)}' -H 'User-Agent: Mozilla/5.0' | sed -n 's/<[^>]*>//gp' | head -100`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: 15_000 });
  if (!stdout.trim()) return stderr || 'No results found.';
  return truncate(stdout.trim());
}

async function executeWebFetch(args: { url: string }): Promise<string> {
  const cmd = `curl -sS -L --max-time 30 --max-filesize 1048576 '${args.url.replace(/'/g, "'\\''")}' | head -c 100000`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: 35_000 });
  if (!stdout.trim()) return stderr || 'Empty response.';
  return truncate(stdout.trim());
}

function resolvePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve('/workspace/group', p);
}

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command in the container. Commands run in /workspace/group. Use for running scripts, installing packages, building, testing, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to /workspace/group or absolute)' },
          start_line: { type: 'number', description: 'Start line (1-indexed, optional)' },
          end_line: { type: 'number', description: 'End line (inclusive, optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed. Overwrites existing content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing old_text with new_text. The old_text must match exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_text: { type: 'string', description: 'Exact text to find and replace' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: current directory)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a pattern in files. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex)' },
          path: { type: 'string', description: 'Directory or file to search (default: current directory)' },
          include: { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Filename pattern, e.g. "*.ts" or "package.json"' },
          path: { type: 'string', description: 'Root directory to search from' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch content from a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
];
