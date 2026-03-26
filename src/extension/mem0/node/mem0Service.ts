/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService, NO_FETCH_TELEMETRY } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IMem0Service, Mem0AddResult, Mem0Memory } from '../common/mem0Types';

const DEFAULT_SEARCH_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 5000;
const ADD_TIMEOUT_MS = 30000;
const COMPRESS_TIMEOUT_MS = 15000;

const COMPRESS_SYSTEM_PROMPT = `You are a memory context compressor for an AI coding assistant. Your task is to deduplicate, merge, and compress a list of recalled long-term memory entries while preserving all unique and useful information.

Rules:
1. Merge entries that express the same fact or preference into a single concise statement.
2. Remove exact or near-exact duplicates, keeping the most informative version.
3. Preserve all distinct technical details: language/framework preferences, project conventions, tool configurations, architectural decisions, debugging insights.
4. Keep the output as a numbered list — one fact per line, no commentary.
5. Do NOT invent new information. Only reorganize and compress what is given.
6. Maintain the original language of each entry (do not translate).
7. Output ONLY the compressed list, nothing else.

Example input:
1. User prefers TypeScript with strict mode
2. Uses pnpm as package manager
3. Prefers TypeScript strict mode for all projects
4. Package manager is pnpm
5. Always use tabs for indentation

Example output:
1. Prefers TypeScript with strict mode for all projects
2. Uses pnpm as package manager
3. Always use tabs for indentation`;

export class Mem0Service extends Disposable implements IMem0Service {
	declare readonly _serviceBrand: undefined;

	private _defaultModelCache: Map<string, string> = new Map();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@IEnvService private readonly envService: IEnvService,
	) {
		super();
	}

	private get endpoint(): string {
		return this.configurationService.getConfig(ConfigKey.Mem0Endpoint) || 'http://127.0.0.1:8080';
	}

	private get userId(): string {
		const configured = this.configurationService.getConfig(ConfigKey.Mem0UserId);
		if (configured) {
			return configured;
		}
		// Fall back to machine ID as a stable user identifier
		return this.envService.machineId || 'default';
	}

	private get enabled(): boolean {
		return this.configurationService.getConfig(ConfigKey.Mem0Enabled) ?? false;
	}

	async search(query: string, limit?: number): Promise<readonly Mem0Memory[]> {
		if (!this.enabled) {
			return [];
		}

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${this.endpoint}/search`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						query,
						user_id: this.userId,
						limit: limit ?? DEFAULT_SEARCH_LIMIT,
					}),
					signal: abort.signal,
				});

				if (!response.ok) {
					this.logService.warn(`[Mem0] search failed: ${response.status} ${response.statusText}`);
					return [];
				}

				const data = await response.json() as { results: Mem0Memory[] };
				const results = data.results ?? [];
				const minScore = this.configurationService.getConfig(ConfigKey.Mem0MinRelevanceScore) ?? 0.5;
				const filtered = results.filter(m => (m.score ?? 1) >= minScore);
				this.logService.trace(`[Mem0] search OK: ${results.length} results, ${filtered.length} after filtering (minScore=${minScore})`);
				return filtered;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			this.logService.warn(`[Mem0] search unavailable: ${e}`);
			return [];
		}
	}

	async add(messages: readonly { role: string; content: string }[], metadata?: Record<string, unknown>): Promise<Mem0AddResult | undefined> {
		if (!this.enabled) {
			return undefined;
		}

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), ADD_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${this.endpoint}/memories`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						messages,
						user_id: this.userId,
						metadata,
					}),
					signal: abort.signal,
				});

				if (!response.ok) {
					this.logService.warn(`[Mem0] add failed: ${response.status} ${response.statusText}`);
					return undefined;
				}

				const addResult = await response.json() as Mem0AddResult;
				this.logService.trace(`[Mem0] add OK: ${addResult.results?.length ?? 0} entries (${addResult.results?.map(r => r.event).join(', ')})`);
				return addResult;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			this.logService.warn(`[Mem0] add unavailable: ${e}`);
			return undefined;
		}
	}

	async getAll(): Promise<readonly Mem0Memory[]> {
		if (!this.enabled) {
			return [];
		}

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${this.endpoint}/memories?user_id=${encodeURIComponent(this.userId)}`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'GET',
					signal: abort.signal,
				});

				if (!response.ok) {
					this.logService.warn(`[Mem0] getAll failed: ${response.status} ${response.statusText}`);
					return [];
				}

				const data = await response.json() as { results: Mem0Memory[] };
				const allResults = data.results ?? [];
				this.logService.trace(`[Mem0] getAll OK: ${allResults.length} memories`);
				return allResults;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			this.logService.warn(`[Mem0] getAll unavailable: ${e}`);
			return [];
		}
	}

	async compressContext(text: string): Promise<string> {
		if (!this.enabled || !text.trim()) {
			return text;
		}

		const compressEnabled = this.configurationService.getConfig(ConfigKey.Mem0CompressEnabled) ?? false;
		if (!compressEnabled) {
			return text;
		}

		const llmEndpoint = this.configurationService.getConfig(ConfigKey.Mem0CompressLlmEndpoint) || 'http://127.0.0.1:11434/v1';
		const configuredModel = this.configurationService.getConfig(ConfigKey.Mem0CompressLlmModel);
		const llmModel = configuredModel || await this._resolveDefaultModel(llmEndpoint);

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), COMPRESS_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${llmEndpoint}/chat/completions`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: llmModel,
						temperature: 0,
						messages: [
							{ role: 'system', content: COMPRESS_SYSTEM_PROMPT },
							{ role: 'user', content: text },
						],
					}),
					signal: abort.signal,
				});

				if (!response.ok) {
					this.logService.warn(`[Mem0] compress LLM call failed: ${response.status} ${response.statusText}`);
					return text;
				}

				const data = await response.json() as { choices?: { message?: { content?: string } }[] };
				const compressed = data.choices?.[0]?.message?.content?.trim();
				if (!compressed) {
					this.logService.warn('[Mem0] compress LLM returned empty content');
					return text;
				}
				this.logService.trace(`[Mem0] compressed memory context: ${text.length} -> ${compressed.length} chars`);
				return compressed;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			this.logService.warn(`[Mem0] compress LLM unavailable, using original text: ${e}`);
			return text;
		}
	}

	private async _resolveDefaultModel(llmEndpoint: string): Promise<string | undefined> {
		const cached = this._defaultModelCache.get(llmEndpoint);
		if (cached) {
			return cached;
		}

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${llmEndpoint}/models`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'GET',
					signal: abort.signal,
				});

				if (!response.ok) {
					this.logService.warn(`[Mem0] failed to query models: ${response.status}`);
					return undefined;
				}

				const data = await response.json() as { data?: { id: string }[] };
				const modelId = data.data?.[0]?.id;
				if (modelId) {
					this._defaultModelCache.set(llmEndpoint, modelId);
					this.logService.trace(`[Mem0] resolved default compress model: ${modelId}`);
				}
				return modelId;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			this.logService.warn(`[Mem0] failed to resolve default model: ${e}`);
			return undefined;
		}
	}
}
