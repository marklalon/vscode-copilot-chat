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


export class Mem0Service extends Disposable implements IMem0Service {
	declare readonly _serviceBrand: undefined;


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

		const requestStartMs = Date.now();

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
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0] search failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return [];
				}

				const data = await response.json() as { results: Mem0Memory[] };
				const results = data.results ?? [];
				const minScore = this.configurationService.getConfig(ConfigKey.Mem0MinRelevanceScore) ?? 0.5;
				const filtered = results.filter(m => (m.score ?? 1) >= minScore);
				const elapsedMs = Date.now() - requestStartMs;
				this.logService.trace(`[Mem0] search OK: ${results.length} results, ${filtered.length} after filtering (minScore=${minScore}), elapsedMs=${elapsedMs}`);
				return filtered;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0] search unavailable: ${e}, elapsedMs=${elapsedMs}`);
			return [];
		}
	}

	async add(messages: readonly { role: string; content: string }[], metadata?: Record<string, unknown>): Promise<Mem0AddResult | undefined> {
		if (!this.enabled) {
			return undefined;
		}

		const requestStartMs = Date.now();

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
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0] add failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return undefined;
				}

				const addResult = await response.json() as Mem0AddResult;
				const elapsedMs = Date.now() - requestStartMs;
				this.logService.trace(`[Mem0] add OK: ${addResult.results?.length ?? 0} entries (${addResult.results?.map(r => r.event).join(', ')}), elapsedMs=${elapsedMs}`);
				return addResult;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0] add unavailable: ${e}, elapsedMs=${elapsedMs}`);
			return undefined;
		}
	}

	async getAll(): Promise<readonly Mem0Memory[]> {
		if (!this.enabled) {
			return [];
		}

		const requestStartMs = Date.now();

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
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0] getAll failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return [];
				}

				const data = await response.json() as { results: Mem0Memory[] };
				const allResults = data.results ?? [];
				const elapsedMs = Date.now() - requestStartMs;
				this.logService.trace(`[Mem0] getAll OK: ${allResults.length} memories, elapsedMs=${elapsedMs}`);
				return allResults;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0] getAll unavailable: ${e}, elapsedMs=${elapsedMs}`);
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

		const requestStartMs = Date.now();

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), COMPRESS_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${this.endpoint}/compress`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text }),
					signal: abort.signal,
				});

				if (!response.ok) {
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0] compress failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return text;
				}

				const data = await response.json() as { compressed?: string };
				const compressed = data.compressed?.trim();
				if (!compressed) {
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0] compress returned empty content, elapsedMs=${elapsedMs}`);
					return text;
				}
				const elapsedMs = Date.now() - requestStartMs;
				this.logService.trace(`[Mem0] compressed memory context: ${text.length} -> ${compressed.length} chars, elapsedMs=${elapsedMs}`);
				return compressed;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0] compress unavailable, using original text: ${e}, elapsedMs=${elapsedMs}`);
			return text;
		}
	}
}
