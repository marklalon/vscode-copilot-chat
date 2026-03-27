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

**Recall**: Every turn, `Mem0ContextPrompt` searches mem0 for memories semantically relevant to the user's message, filters by relevance score, and injects them into the prompt.

**Write-back**: Only on the final conversation turn, `toolCallingLoop` sends the user+assistant messages to mem0 asynchronously. mem0 internally uses an LLM to extract and deduplicate facts.

## Files

| File | Purpose |
|------|---------|
| `common/mem0Types.ts` | `IMem0Service` interface, `Mem0Memory`, `Mem0AddResult` types |
| `node/mem0Service.ts` | Service implementation — HTTP client for mem0 REST API |
| `node/mem0ContextPrompt.tsx` | TSX prompt component that renders recalled memories |
| `node/test/mem0Service.spec.ts` | 24 unit tests |

### Modified files (outside this directory)

| File | Change |
|------|--------|
| `prompts/node/agent/agentPrompt.tsx` | Renders `<Mem0ContextPrompt>` in the prompt hierarchy |
| `intents/node/toolCallingLoop.ts` | `_storeMem0Memory()` write-back on last turn |
| `extension/vscode-node/services.ts` | DI registration: `IMem0Service → Mem0Service` |
| `platform/configuration/common/configurationService.ts` | All `ConfigKey.Mem0*` entries |

## Settings

All settings are under `github.copilot.chat.mem0.*` in VS Code Settings (`Ctrl+,`, search `mem0`).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Master toggle for mem0 integration |
| `endpoint` | string | `http://127.0.0.1:8080` | mem0 REST API base URL |
| `userId` | string | `""` | User ID for memory isolation (empty = machineId) |
| `minRelevanceScore` | number | `0.5` | Minimum score to include a recalled memory |
| `compressEnabled` | boolean | `false` | Enable dedup/compression of recalled memory context via mem0 `/compress` |
| `compressThreshold` | number | `2000` | Character count threshold to trigger compression |

## mem0 API Endpoints

The self-hosted mem0 Docker uses these paths (**no `/v1/` prefix**):

| Method | Path | Timeout | Description |
|--------|------|---------|-------------|
| POST | `/search` | 5s | Semantic memory search |
| POST | `/memories` | 30s | Add memories (slow — internal LLM extraction) |
| GET | `/memories?user_id=` | 5s | Get all memories for a user |
| POST | `/compress` | 15s | Deduplicate and compress memory context using server-side LLM |

## Prerequisites

1. **mem0 Docker** running locally:
   ```bash
   docker run -d -p 8080:8000 mem0ai/mem0:latest
   ```

2. **Enable** in VS Code settings:
   - Set `github.copilot.chat.mem0.enabled` to `true`
   - Set `github.copilot.chat.mem0.endpoint` to your mem0 URL

3. (Optional) **Compression** — deduplicate recalled memories before injecting into prompt:
   - Set `compressEnabled` to `true`
   - Compression is handled server-side by the mem0 service (`POST /compress`) using its own configured LLM — no extra client-side LLM configuration needed

## Logging

All logs use `[Mem0]` prefix. View in: Output panel → GitHub Copilot Chat.

| Level | Message | When |
|-------|---------|------|
| trace | `search OK: N results, M after filtering` | Successful search |
| trace | `add OK: N entries (ADD, UPDATE, ...)` | Successful write-back |
| trace | `getAll OK: N memories` | Successful getAll |
| trace | `compressed memory context: X -> Y chars` | Successful compression |
| trace | `Recalled N memories for query` | Prompt component found results |
| warn | `search failed: 404 Not Found` | HTTP error |
| warn | `add unavailable: AbortError` | Timeout or network error |

Set log level to **Trace** to see success logs: `Ctrl+Shift+P` → `Developer: Set Log Level` → `Trace`.

## Design Decisions

- **Per-turn recall**: mem0 search runs every turn because the query changes; existing `MemoryContextPrompt` remains first-turn only
- **Last-turn-only write**: Avoids redundant writes mid-conversation when tool calls are still in progress
- **Fire-and-forget**: Write-back is async and best-effort — never blocks or fails the chat
- **Graceful fallback**: All mem0 calls return empty/original on failure
- **Score filtering**: Reduces noise from low-relevance memories before injecting into prompt
- **Separate component**: Independent from existing memory systems to avoid coupling

## Running Tests

```bash
npx vitest run src/extension/mem0/node/test/mem0Service.spec.ts
```
