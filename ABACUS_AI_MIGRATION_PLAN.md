# NanoClaw → Abacus AI Migration Plan

## Executive Summary

Replace Claude Agent SDK with Abacus AI as the agent backend for NanoClaw. Two implementation approaches provided:

1. **Approach A (Recommended)**: Abacus AI Desktop CLI - Drop-in replacement
2. **Approach B (Advanced)**: Hybrid RouteLLM API with custom agent loop

---

## Approach A: Abacus AI Desktop CLI Integration

### Overview
Replace `@anthropic-ai/claude-code` with `@abacus-ai/cli` inside the container. Minimal architectural changes - the agent runner still spawns a coding agent via CLI, but powered by Abacus AI models instead of Claude.

### Advantages
- ✅ Minimal code changes (mostly package swaps)
- ✅ Maintains NanoClaw's security model (container isolation)
- ✅ Preserves existing IPC patterns
- ✅ Abacus AI Desktop likely has similar tool capabilities (bash, file ops, web)
- ✅ Faster to implement and test
- ✅ Lower risk of breaking existing features

### Changes Required

#### 1. Container Dockerfile (`container/Dockerfile`)
```diff
- # Install agent-browser and claude-code globally
- RUN npm install -g agent-browser @anthropic-ai/claude-code
+ # Install agent-browser and abacus-ai CLI globally
+ RUN npm install -g agent-browser @abacus-ai/cli
```

#### 2. Container agent-runner package.json (`container/agent-runner/package.json`)
```diff
  "dependencies": {
-   "@anthropic-ai/claude-agent-sdk": "^0.2.34",
+   "@abacus-ai/cli": "^1.106.25008",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "cron-parser": "^5.0.0",
    "zod": "^4.0.0"
  }
```

#### 3. Agent Runner Core (`container/agent-runner/src/index.ts`)

**Major changes:**
- Replace `query()` from `@anthropic-ai/claude-agent-sdk` with Abacus AI Desktop API
- Research Abacus AI Desktop's API for:
  - How to invoke the agent programmatically (not just CLI)
  - Streaming response support
  - Tool/MCP server integration
  - Session management
  - Hooks (PreCompact, PreToolUse equivalents)

**Investigation needed:**
- Does `@abacus-ai/cli` expose a programmatic API or only CLI?
- If CLI-only, we'd need to spawn `abacusai` command and parse output
- Alternative: Use Abacus AI Python SDK and bridge via child process

#### 4. Environment Variables (`.env`)
```diff
- CLAUDE_CODE_OAUTH_TOKEN=...
- ANTHROPIC_API_KEY=...
+ ABACUS_AI_API_KEY=...
```

**Note:** Need to verify authentication method for Abacus AI Desktop CLI.

#### 5. Secret Handling (`src/env.ts`, `src/container-runner.ts`)
```diff
- return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
+ return readEnvFile(['ABACUS_AI_API_KEY']);
```

#### 6. Documentation Updates
- Update README.md setup instructions
- Update groups/main/CLAUDE.md and groups/global/CLAUDE.md
- Update CLAUDE.md project context file
- Update setup/whatsapp-auth.ts (if it references Claude)

### Unknown/Research Items
1. **Abacus AI Desktop programmatic API**: Does `@abacus-ai/cli` expose a Node.js API or is it CLI-only?
2. **Tool/MCP integration**: How does Abacus AI Desktop integrate with MCP servers?
3. **Streaming**: Does it support streaming responses like Claude Agent SDK?
4. **Session persistence**: How are sessions stored and resumed?
5. **Permissions model**: Does it have equivalent to `allowDangerouslySkipPermissions`?
6. **Hooks**: Can we intercept/modify tool calls and handle pre-compact events?
7. **Browser automation**: Is agent-browser compatible or does Abacus have its own?

### Implementation Steps (Approach A)
1. ✅ Research Abacus AI Desktop CLI documentation and API surface
2. Set up test Abacus AI account and obtain API key
3. Create feature branch `feat/abacus-ai-desktop`
4. Update container Dockerfile and rebuild image
5. Rewrite agent-runner/src/index.ts to use Abacus AI Desktop API
6. Test basic agent invocation (single query, no tools)
7. Implement MCP server integration
8. Test IPC message piping (follow-up messages)
9. Test task scheduling
10. Test browser automation integration
11. Update all documentation
12. End-to-end testing with WhatsApp
13. Deploy and monitor

---

## Approach B: Hybrid RouteLLM API + Custom Agent Loop

### Overview
Use Abacus AI's RouteLLM API (OpenAI-compatible) for the LLM brain, but build a lightweight agent loop inside the container that:
- Executes tools (Bash, Read, Write, Edit, Grep, WebSearch, WebFetch)
- Manages MCP server integration
- Handles multi-turn conversations
- Streams results back to the host

This keeps NanoClaw's container tool infrastructure (IPC, mount security, group isolation) while swapping the LLM backend.

### Advantages
- ✅ More control over agent behavior
- ✅ Can optimize for NanoClaw's specific use case
- ✅ Uses battle-tested RouteLLM API (OpenAI-compatible, well-documented)
- ✅ Tool calling is native (OpenAI-style function calling)
- ✅ Can switch models easily (route-llm, claude-4-5-sonnet, gpt-5.2, etc.)
- ✅ Keeps existing tool implementations

### Disadvantages
- ❌ More code to write (custom agent loop)
- ❌ Need to implement: tool execution, error handling, safety checks, context management
- ❌ Higher complexity than Approach A
- ❌ Longer development time
- ❌ More testing required

### Changes Required

#### 1. Container Dockerfile
```diff
- # Install agent-browser and claude-code globally
- RUN npm install -g agent-browser @anthropic-ai/claude-code
+ # Install agent-browser and OpenAI SDK for RouteLLM
+ RUN npm install -g agent-browser
```

#### 2. Container agent-runner package.json
```diff
  "dependencies": {
-   "@anthropic-ai/claude-agent-sdk": "^0.2.34",
+   "openai": "^4.x.x",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "cron-parser": "^5.0.0",
    "zod": "^4.0.0"
  }
```

#### 3. Agent Runner Core (`container/agent-runner/src/index.ts`)

**Complete rewrite needed:**
```typescript
import OpenAI from 'openai';

// Initialize Abacus AI RouteLLM client
const client = new OpenAI({
  baseURL: 'https://routellm.abacus.ai/v1',
  apiKey: process.env.ABACUS_AI_API_KEY,
});

// Custom agent loop:
// 1. Build initial messages with system prompt + user message
// 2. Call client.chat.completions.create() with tools defined
// 3. If response contains tool_calls:
//    - Execute each tool (bash, read, write, mcp_nanoclaw, etc.)
//    - Append tool results to messages
//    - Loop back to step 2
// 4. If response finish_reason is 'stop', return final result
// 5. Handle streaming, errors, timeouts
```

**Tools to implement:**
- `bash` - Execute shell commands
- `read_file` - Read file contents
- `write_file` - Write file contents
- `edit_file` - Edit file with line-based operations
- `glob` - List files matching pattern
- `grep` - Search file contents
- `web_search` - Search the web
- `web_fetch` - Fetch URL content
- `mcp_nanoclaw__*` - Forward to MCP server (send_message, schedule_task, etc.)

#### 4. Tool Execution Layer (new file: `container/agent-runner/src/tools.ts`)

Implement each tool as a function that:
- Takes tool input (from LLM's tool_call.function.arguments)
- Executes the operation (spawn bash, fs operations, HTTP requests)
- Returns result as string/JSON
- Handles errors gracefully

**Example:**
```typescript
async function executeBashTool(args: { command: string }): Promise<string> {
  // Strip secrets from env
  const sanitizedCommand = `unset ABACUS_AI_API_KEY; ${args.command}`;
  
  // Spawn bash subprocess
  const result = await execAsync(sanitizedCommand, {
    cwd: '/workspace/group',
    timeout: 300000,
  });
  
  return result.stdout + result.stderr;
}
```

#### 5. MCP Integration
Keep existing `ipc-mcp-stdio.ts` MCP server, invoke it as before. When LLM calls `mcp_nanoclaw__send_message`, forward to the MCP server via stdio.

#### 6. Conversation Management
- Store messages array in memory
- Implement context window management (truncate old messages when approaching limit)
- Support session resumption (reload messages from disk)

#### 7. Streaming Implementation
Use OpenAI SDK's streaming support:
```typescript
const stream = await client.chat.completions.create({
  model: 'route-llm', // or claude-4-5-sonnet, gpt-5.2, etc.
  messages: conversationMessages,
  tools: toolDefinitions,
  stream: true,
});

for await (const chunk of stream) {
  if (chunk.choices[0]?.delta?.content) {
    // Write partial output via OUTPUT_MARKER
    writeOutput({ status: 'success', result: chunk.choices[0].delta.content });
  }
  if (chunk.choices[0]?.delta?.tool_calls) {
    // Accumulate tool calls
  }
}
```

### Implementation Steps (Approach B)
1. Create feature branch `feat/abacus-routellm-hybrid`
2. Update container Dockerfile and package.json
3. Implement tool execution layer (`tools.ts`)
4. Implement custom agent loop in `index.ts`
5. Add OpenAI SDK integration with RouteLLM
6. Test each tool individually
7. Test multi-turn conversations
8. Implement streaming
9. Implement MCP integration
10. Test IPC message piping
11. Test task scheduling
12. Update documentation
13. End-to-end testing
14. Deploy and monitor

---

## Comparison Matrix

| Feature | Approach A (Abacus CLI) | Approach B (RouteLLM + Custom Loop) |
|---------|-------------------------|-------------------------------------|
| Development Time | 🟢 Low (1-2 weeks) | 🔴 High (3-4 weeks) |
| Code Changes | 🟢 Minimal | 🔴 Extensive |
| Risk | 🟢 Low | 🟡 Medium |
| Control | 🟡 Medium | 🟢 High |
| Flexibility | 🟡 Medium | 🟢 High |
| Testing Effort | 🟢 Low | 🔴 High |
| Model Switching | 🟡 Depends on CLI | 🟢 Easy (.env change) |
| Tool Ecosystem | 🟡 Depends on Abacus Desktop | 🟢 Full control |
| Maintenance | 🟢 Low (fewer moving parts) | 🟡 Medium (custom code) |

---

## Recommendation

**Start with Approach A (Abacus AI Desktop CLI)** for these reasons:

1. **Lower risk**: Minimal changes to proven architecture
2. **Faster MVP**: Can validate Abacus AI in production quickly
3. **Easier rollback**: If Abacus AI doesn't work well, easy to revert
4. **Discovery phase**: Will reveal Abacus AI's capabilities/limitations

**Fallback to Approach B** if:
- Abacus AI Desktop CLI doesn't expose a programmatic API
- Tool integration is poor/missing
- Performance/reliability issues
- Need more control over agent behavior

---

## Migration Checklist

### Phase 1: Research & Setup
- [ ] Research `@abacus-ai/cli` API documentation
- [ ] Create Abacus AI account and obtain API key
- [ ] Test Abacus AI Desktop locally
- [ ] Verify tool capabilities (bash, file ops, web, MCP)
- [ ] Document API surface and limitations

### Phase 2: Implementation (Approach A)
- [ ] Create feature branch
- [ ] Update Dockerfile and rebuild container
- [ ] Rewrite agent-runner to use Abacus AI Desktop
- [ ] Implement session management
- [ ] Implement streaming (if supported)
- [ ] Integrate MCP server
- [ ] Update secret handling

### Phase 3: Testing
- [ ] Unit tests for agent-runner
- [ ] Test basic queries (no tools)
- [ ] Test bash tool execution
- [ ] Test file operations
- [ ] Test web search/fetch
- [ ] Test MCP tools (send_message, schedule_task)
- [ ] Test IPC message piping
- [ ] Test scheduled tasks
- [ ] Test browser automation (agent-browser)
- [ ] Load testing (concurrent containers)

### Phase 4: Documentation
- [ ] Update README.md
- [ ] Update setup instructions
- [ ] Update CLAUDE.md files (main, global)
- [ ] Update docs/REQUIREMENTS.md
- [ ] Create migration guide for existing users
- [ ] Update .env.example

### Phase 5: Deployment
- [ ] Deploy to staging environment
- [ ] Run end-to-end tests with WhatsApp
- [ ] Monitor logs and performance
- [ ] Gradual rollout (1 group → all groups)
- [ ] Production deployment
- [ ] Post-deployment monitoring

---

## Open Questions

1. **Abacus AI Desktop API**: Is there a Node.js API or only CLI?
2. **Pricing**: How does Abacus AI pricing compare to Claude Code?
3. **Rate limits**: What are the API rate limits for RouteLLM?
4. **Model switching**: Can we switch models per-group or globally only?
5. **Context window**: What's the max context for route-llm?
6. **Tool calling**: Does Abacus AI Desktop support custom MCP servers?
7. **Streaming**: Does the CLI support streaming output?
8. **Session persistence**: Where are sessions stored?
9. **Browser automation**: Is agent-browser compatible?
10. **Error handling**: How are tool errors surfaced?

---

## Next Steps

1. **User decision**: Choose Approach A or Approach B
2. **Research sprint** (2-3 days): Answer open questions
3. **Proof of concept** (1 week): Minimal working prototype
4. **Review & decision point**: Proceed or pivot to Approach B
5. **Full implementation**: Complete feature branch
6. **Testing & deployment**: Roll out to production

---

## Success Criteria

✅ All existing NanoClaw features work with Abacus AI backend  
✅ Message processing latency ≤ current Claude Agent SDK  
✅ No regressions in security/isolation model  
✅ Scheduled tasks run successfully  
✅ Browser automation works  
✅ IPC message piping works  
✅ Multi-group isolation maintained  
✅ Documentation updated  
✅ Smooth migration path for existing users  

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Abacus AI Desktop lacks programmatic API | Fall back to Approach B (RouteLLM + custom loop) |
| MCP integration broken | Reimplement MCP tools as native RouteLLM tools |
| Performance degradation | Profile and optimize, or revert to Claude |
| Missing tool capabilities | Implement missing tools in custom layer |
| Breaking changes in Abacus AI | Pin specific versions, monitor releases |
| Cost overruns | Monitor API usage, implement rate limiting |
