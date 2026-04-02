# Mem0 Integration

Local long-term memory layer for GitHub Copilot Chat, powered by [mem0](https://github.com/mem0ai/mem0) self-hosted Docker.

## How It Works

```
User Message
     │
     ▼
┌──────────────┐    POST /search     ┌─────────┐
│ Mem0Context  │ ──────────────────►  │  mem0    │
│ Prompt (TSX) │ ◄──────────────────  │ Docker  │
└──────┬───────┘   relevant memories  └─────────┘
       │
       ▼
  Injected into prompt context
  (up to 1500 tokens)
       │
       ▼
┌──────────────┐
│   LLM sees   │
│  memories +  │
│  user query  │
└──────┬───────┘
       │
       ▼
  Response generated
       │
       ▼
┌──────────────┐    POST /memories    ┌─────────┐
│ToolCalling   │ ──────────────────►  │  mem0    │
│Loop (last    │   (fire & forget)    │ extracts │
│  turn only)  │                      │  facts)  │
└──────────────┘                      └─────────┘
```

**Recall**: On the first model request for each user turn, `Mem0ContextPrompt` searches mem0 for memories semantically relevant to the user's message, filters by relevance score, and injects them into the prompt.

**Write-back**: Only on the final conversation turn, `toolCallingLoop` sends the user+assistant messages to mem0 asynchronously. mem0 internally uses an LLM to extract and deduplicate facts.

**Smart Compact**: The normal `/compact` flow keeps using Copilot's summarization pipeline, but it can optionally redirect the LLM call to a local OpenAI-compatible endpoint via `github.copilot.chat.mem0.compactLlmEndpoint`. When enabled, the original pre-compact transcript is saved under `.vscode/.cache/compact-pre-*.md`, and only the 10 newest snapshots are retained.

## Files

| File | Purpose |
|------|---------|
| `common/mem0Types.ts` | `IMem0Service` interface, `Mem0Memory`, `Mem0AddResult` types |
| `common/mem0SmartCompactTypes.ts` | `IMem0SmartCompactService` interface for `/compact` local LLM resolution |
| `node/mem0Service.ts` | Service implementation for mem0 search, add, getAll, and project-scoped user ID resolution |
| `node/mem0SmartCompactService.ts` | Smart Compact endpoint resolution, local LLM override, prompt loading, and pre-compact cache retention |
| `node/mem0ContextPrompt.tsx` | TSX prompt component that renders recalled memories |
| `node/test/mem0Service.spec.ts` | Unit tests for mem0 REST integration behavior |
| `node/test/mem0SmartCompactService.spec.ts` | Unit tests for Smart Compact override and cache pruning |

### Modified files (outside this directory)

| File | Change |
|------|--------|
| `prompts/node/agent/agentPrompt.tsx` | Renders `<Mem0ContextPrompt>` in the prompt hierarchy |
| `intents/node/agentIntent.ts` | Delegates `/compact` endpoint selection to `IMem0SmartCompactService` |
| `intents/node/toolCallingLoop.ts` | `_storeMem0Memory()` write-back on last turn |
| `extension/vscode-node/services.ts` | DI registration: `IMem0Service -> Mem0Service`, `IMem0SmartCompactService -> Mem0SmartCompactService` |
| `platform/configuration/common/configurationService.ts` | All `ConfigKey.Mem0*` entries |

## Settings

UI-exposed settings are under `github.copilot.chat.mem0.*` in VS Code Settings (`Ctrl+,`, search `mem0`).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Master toggle for mem0 integration |
| `endpoint` | string | `http://127.0.0.1:8080` | mem0 REST API base URL |
| `minRelevanceScore` | number | `0.5` | Minimum score to include a recalled memory |
| `compactLlmEndpoint` | string | `""` | Optional `/v1` base URL for a local OpenAI-compatible model used by Smart Compact (`/compact`) |

### Project-scoped user ID

mem0 user isolation now uses a project-scoped identifier stored in `.vscode/mem0.json`:

```json
{
   "userId": "workspace:550e8400-e29b-41d4-a716-446655440000"
}
```

- If `.vscode/mem0.json` exists and contains `userId`, that value is used.
- If it is missing/invalid, a new `workspace:<uuid>` value is generated and written back to `.vscode/mem0.json`.
- `github.copilot.chat.mem0.userId` is no longer exposed in Settings UI.

## mem0 API Endpoints

The self-hosted mem0 Docker uses these paths (**no `/v1/` prefix**):

| Method | Path | Timeout | Description |
|--------|------|---------|-------------|
| POST | `/search` | 5s | Semantic memory search |
| POST | `/memories` | 30s | Add memories (slow — internal LLM extraction) |
| GET | `/memories?user_id=` | 5s | Get all memories for a user |

## Prerequisites

1. **mem0 Docker** running locally:
   ```bash
   docker run -d -p 8080:8000 mem0ai/mem0:latest
   ```

2. **Enable** in VS Code settings:
   - Set `github.copilot.chat.mem0.enabled` to `true`
   - Set `github.copilot.chat.mem0.endpoint` to your mem0 URL

3. **Optional Smart Compact override**:
   - Set `github.copilot.chat.mem0.compactLlmEndpoint` to a local OpenAI-compatible `/v1` base URL if you want `/compact` to use a local model.
   - Example values: `http://127.0.0.1:18081/v1`.
   - If this setting is empty, `/compact` uses the normal Copilot model selection flow.

## Logging

mem0 request logs use `[Mem0][userId]`. Smart Compact override logs use `[mem0][compact]`. View them in: Output panel -> GitHub Copilot Chat.

| Level | Message | When |
|-------|---------|------|
| debug | `[Mem0][userId] search OK: N results, M after filtering` | Successful search |
| debug | `[Mem0][userId] add OK: N entries (ADD, UPDATE, ...)` | Successful write-back |
| debug | `[Mem0][userId] getAll OK: N memories` | Successful getAll |
| debug | `Recalled N memories for query` | Prompt component found results |
| debug | `[mem0][compact] saved pre-compact content to ...` | Smart Compact wrote a transcript snapshot |
| debug | `[mem0][compact] pruned old pre-compact cache ...` | Old compact snapshots were deleted |
| warn | `[Mem0][userId] search failed: 404 Not Found` | HTTP error |
| warn | `[Mem0][userId] search unavailable: AbortError` | Timeout or network error |
| warn | `[Mem0][userId] add failed: 404 Not Found` | HTTP error |
| warn | `[Mem0][userId] add unavailable: AbortError` | Timeout or network error |
| warn | `[Mem0][userId] getAll failed: 404 Not Found` | HTTP error |
| warn | `[Mem0][userId] getAll unavailable: AbortError` | Timeout or network error |
| warn | `[mem0][compact] model discovery failed ...` | Smart Compact local model discovery failed |
| warn | `[mem0][compact] failed to save pre-compact cache ...` | Snapshot persistence failed |

Set log level to **Debug** to see success logs: `Ctrl+Shift+P` → `Developer: Set Log Level` → `Debug`.

## Design Decisions

- **Per-user-turn recall**: mem0 search runs on the first model request of each user turn to avoid repeated recalls during tool-call iterations
- **Last-turn-only write**: Avoids redundant writes mid-conversation when tool calls are still in progress
- **Compaction decoupled from mem0**: mem0 no longer owns conversation compaction; `/compact` stays in the summarization pipeline and only swaps the target LLM URL when configured
- **Snapshot retention**: Smart Compact stores pre-compact transcripts in `.vscode/.cache` and prunes older files to keep only the 10 newest snapshots
- **Fire-and-forget**: Write-back is async and best-effort — never blocks or fails the chat
- **Graceful fallback**: All mem0 calls return empty/original on failure
- **Score filtering**: Reduces noise from low-relevance memories before injecting into prompt
- **Separate component**: Independent from existing memory systems to avoid coupling

## Running Tests

```bash
npx vitest run src/extension/mem0/node/test/mem0Service.spec.ts
npx vitest run src/extension/mem0/node/test/mem0SmartCompactService.spec.ts
```

### Real mem0 E2E (add -> clear -> verify)

Requires a running mem0 server (for example `http://127.0.0.1:18000`).

```powershell
powershell -ExecutionPolicy Bypass -File src/extension/mem0/node/test/test-mem0-clear-e2e.ps1 -Mem0Url http://127.0.0.1:18000 -UserId workspace:e2e-clear-test
```

If your mem0 server enables API-key auth, pass `-ApiKey <your_key>`.
