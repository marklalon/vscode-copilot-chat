/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IFileSystemService, createDirectoryIfNotExists } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService, NO_FETCH_TELEMETRY } from '../../../platform/networking/common/fetcherService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { VSBuffer } from '../../../util/vs/base/common/buffer';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IMem0Service, Mem0AddResult, Mem0Memory } from '../common/mem0Types';

const DEFAULT_SEARCH_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 5000;
const ADD_TIMEOUT_MS = 30000;
const MEM0_CONFIG_DIR = '.vscode';
const MEM0_CONFIG_FILE = 'mem0.json';

interface Mem0ProjectConfig {
	readonly userId?: string;
}


export class Mem0Service extends Disposable implements IMem0Service {
	declare readonly _serviceBrand: undefined;
	private userIdPromise: Promise<string> | undefined;


	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) {
		super();
	}

	private get endpoint(): string {
		return this.configurationService.getConfig(ConfigKey.Mem0Endpoint) || 'http://127.0.0.1:8080';
	}

	private get enabled(): boolean {
		return this.configurationService.getConfig(ConfigKey.Mem0Enabled) ?? false;
	}

	private get traceEnabled(): boolean {
		return this.configurationService.getConfig(ConfigKey.Mem0TraceLog) ?? false;
	}

	private getProjectConfigUri(): URI | undefined {
		const workspaceFolder = this.workspaceService.getWorkspaceFolders()[0];
		if (!workspaceFolder) {
			return undefined;
		}
		return URI.joinPath(workspaceFolder, MEM0_CONFIG_DIR, MEM0_CONFIG_FILE);
	}

	private getProjectConfigDirUri(): URI | undefined {
		const workspaceFolder = this.workspaceService.getWorkspaceFolders()[0];
		if (!workspaceFolder) {
			return undefined;
		}
		return URI.joinPath(workspaceFolder, MEM0_CONFIG_DIR);
	}

	private async getUserId(): Promise<string> {
		if (!this.userIdPromise) {
			this.userIdPromise = this.resolveUserId();
		}
		return this.userIdPromise;
	}

	private async resolveUserId(): Promise<string> {
		const configUri = this.getProjectConfigUri();
		if (configUri) {
			let existingConfig: Mem0ProjectConfig = {};
			try {
				const raw = await this.fileSystemService.readFile(configUri, true);
				const text = raw.toString();
				existingConfig = JSON.parse(text) as Mem0ProjectConfig;
				const userId = existingConfig.userId?.trim();
				if (userId) {
					return userId;
				}
			} catch {
				// Ignore and create a new project-local userId below.
			}

			const generatedUserId = `workspace:${generateUuid()}`;
			const dirUri = this.getProjectConfigDirUri()!;
			try {
				await createDirectoryIfNotExists(this.fileSystemService, dirUri);
				const payload = JSON.stringify({ ...existingConfig, userId: generatedUserId }, undefined, '\t');
				await this.fileSystemService.writeFile(configUri, VSBuffer.fromString(payload).buffer);
			} catch (error) {
				this.logService.warn(`[Mem0] Failed to persist project userId to ${configUri.toString()}: ${error}`);
			}
			return generatedUserId;
		}

		const transientUserId = `workspace:${generateUuid()}`;
		this.logService.warn('[Mem0] No workspace folder found, using transient workspace userId');
		return transientUserId;
	}

	async search(query: string, limit?: number): Promise<readonly Mem0Memory[]> {
		if (!this.enabled) {
			return [];
		}

		const userId = await this.getUserId();

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
						user_id: userId,
						limit: limit ?? DEFAULT_SEARCH_LIMIT,
					}),
					signal: abort.signal,
				});

				if (!response.ok) {
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0][${userId}] search failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return [];
				}

				const data = await response.json() as { results: Mem0Memory[] };
				const results = data.results ?? [];
				const minScore = this.configurationService.getConfig(ConfigKey.Mem0MinRelevanceScore) ?? 0.5;
				const filtered = results.filter(m => (m.score ?? 1) >= minScore);
				const elapsedMs = Date.now() - requestStartMs;
				if (this.traceEnabled) { this.logService.trace(`[Mem0][${userId}] search OK: ${results.length} results, ${filtered.length} after filtering (minScore=${minScore}), elapsedMs=${elapsedMs}`); }
				return filtered;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0][${userId}] search unavailable: ${e}, elapsedMs=${elapsedMs}`);
			return [];
		}
	}

	async add(messages: readonly { role: string; content: string }[], metadata?: Record<string, unknown>): Promise<Mem0AddResult | undefined> {
		if (!this.enabled) {
			return undefined;
		}

		const userId = await this.getUserId();

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
						user_id: userId,
						metadata,
					}),
					signal: abort.signal,
				});

				if (!response.ok) {
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0][${userId}] add failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return undefined;
				}

				const addResult = await response.json() as Mem0AddResult;
				const elapsedMs = Date.now() - requestStartMs;
				if (this.traceEnabled) { this.logService.trace(`[Mem0][${userId}] add OK: ${addResult.results?.length ?? 0} entries (${addResult.results?.map(r => r.event).join(', ')}), elapsedMs=${elapsedMs}`); }
				return addResult;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0][${userId}] add unavailable: ${e}, elapsedMs=${elapsedMs}`);
			return undefined;
		}
	}

	async getAll(): Promise<readonly Mem0Memory[]> {
		if (!this.enabled) {
			return [];
		}

		const userId = await this.getUserId();

		const requestStartMs = Date.now();

		try {
			const abort = this.fetcherService.makeAbortController();
			const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await this.fetcherService.fetch(`${this.endpoint}/memories?user_id=${encodeURIComponent(userId)}`, {
					callSite: NO_FETCH_TELEMETRY,
					method: 'GET',
					signal: abort.signal,
				});

				if (!response.ok) {
					const elapsedMs = Date.now() - requestStartMs;
					this.logService.warn(`[Mem0][${userId}] getAll failed: ${response.status} ${response.statusText}, elapsedMs=${elapsedMs}`);
					return [];
				}

				const data = await response.json() as { results: Mem0Memory[] };
				const allResults = data.results ?? [];
				const elapsedMs = Date.now() - requestStartMs;
				if (this.traceEnabled) { this.logService.trace(`[Mem0][${userId}] getAll OK: ${allResults.length} memories, elapsedMs=${elapsedMs}`); }
				return allResults;
			} finally {
				clearTimeout(timer);
			}
		} catch (e) {
			const elapsedMs = Date.now() - requestStartMs;
			this.logService.warn(`[Mem0][${userId}] getAll unavailable: ${e}, elapsedMs=${elapsedMs}`);
			return [];
		}
	}
}
