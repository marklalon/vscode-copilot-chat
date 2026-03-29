/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService, NO_FETCH_TELEMETRY } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IEndpointFetchOptions, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { getCAPITextPart, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IMem0SmartCompactResolution, IMem0SmartCompactService } from '../common/mem0SmartCompactTypes';

const COMPACT_SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../../../../assets/prompts/compactSystemPrompt.md');
const COMPACT_CACHE_FILE_PREFIX = 'compact-pre-';
const MAX_COMPACT_CACHE_FILES = 10;
const SMART_COMPACT_DETAILS = 'Smart Compact';

async function readCompactSystemPrompt(): Promise<string> {
	return fs.readFile(COMPACT_SYSTEM_PROMPT_PATH, 'utf-8');
}

async function pruneCompactCacheFiles(cacheDir: string, logService: ILogService, traceEnabled: boolean): Promise<void> {
	const entries = await fs.readdir(cacheDir, { withFileTypes: true });
	const compactFiles = entries
		.filter(entry => entry.isFile() && entry.name.startsWith(COMPACT_CACHE_FILE_PREFIX) && entry.name.endsWith('.md'))
		.map(entry => path.join(cacheDir, entry.name));

	if (compactFiles.length <= MAX_COMPACT_CACHE_FILES) {
		return;
	}

	const compactFilesWithStats = await Promise.all(compactFiles.map(async filePath => ({
		filePath,
		stat: await fs.stat(filePath),
	})));

	compactFilesWithStats.sort((a, b) => {
		if (b.stat.mtimeMs !== a.stat.mtimeMs) {
			return b.stat.mtimeMs - a.stat.mtimeMs;
		}

		return b.filePath.localeCompare(a.filePath);
	});

	const staleFiles = compactFilesWithStats.slice(MAX_COMPACT_CACHE_FILES).map(entry => entry.filePath);
	const deletionResults = await Promise.allSettled(staleFiles.map(async filePath => {
		await fs.unlink(filePath);
		if (traceEnabled) {
			logService.debug(`[mem0][compact] pruned old pre-compact cache ${filePath}`);
		}
	}));

	for (const result of deletionResults) {
		if (result.status === 'rejected') {
			logService.warn(`[mem0][compact] failed to prune pre-compact cache: ${result.reason}`);
		}
	}
}

export class Mem0SmartCompactService implements IMem0SmartCompactService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async resolveCompactEndpoint(baseEndpoint: IChatEndpoint): Promise<IMem0SmartCompactResolution> {
		const mem0Enabled = this.configurationService.getConfig(ConfigKey.Mem0Enabled) ?? false;
		const compactLlmUrl = mem0Enabled ? this.configurationService.getConfig(ConfigKey.CompactLlmEndpoint)?.trim() : undefined;
		if (!compactLlmUrl) {
			return { endpoint: baseEndpoint };
		}

		return {
			endpoint: this.instantiationService.createInstance(CompactLlmOverrideEndpoint, baseEndpoint, compactLlmUrl),
			details: SMART_COMPACT_DETAILS,
		};
	}
}

export class CompactLlmOverrideEndpoint implements IChatEndpoint {
	constructor(
		private readonly base: IChatEndpoint,
		private readonly compactLlmUrl: string,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	private get traceEnabled(): boolean {
		return this.configurationService.getConfig(ConfigKey.Mem0TraceLog) ?? false;
	}

	get urlOrRequestMetadata() { return this.base.urlOrRequestMetadata; }
	get name() { return this.base.name; }
	get version() { return this.base.version; }
	get family() { return this.base.family; }
	get tokenizer() { return this.base.tokenizer; }
	get modelMaxPromptTokens() { return this.base.modelMaxPromptTokens; }
	get maxOutputTokens() { return this.base.maxOutputTokens; }
	get model() { return this.base.model; }
	get modelProvider() { return this.base.modelProvider; }
	get apiType() { return this.base.apiType; }
	get supportsThinkingContentInHistory() { return this.base.supportsThinkingContentInHistory; }
	get supportsAdaptiveThinking() { return this.base.supportsAdaptiveThinking; }
	get minThinkingBudget() { return this.base.minThinkingBudget; }
	get maxThinkingBudget() { return this.base.maxThinkingBudget; }
	get supportsReasoningEffort() { return this.base.supportsReasoningEffort; }
	get supportsToolCalls() { return this.base.supportsToolCalls; }
	get supportsVision() { return this.base.supportsVision; }
	get supportsPrediction() { return this.base.supportsPrediction; }
	get supportedEditTools() { return this.base.supportedEditTools; }
	get showInModelPicker() { return this.base.showInModelPicker; }
	get isPremium() { return this.base.isPremium; }
	get degradationReason() { return this.base.degradationReason; }
	get multiplier() { return this.base.multiplier; }
	get restrictedToSkus() { return this.base.restrictedToSkus; }
	get isFallback() { return this.base.isFallback; }
	get customModel() { return this.base.customModel; }
	get isExtensionContributed() { return this.base.isExtensionContributed; }
	get maxPromptImages() { return this.base.maxPromptImages; }

	getExtraHeaders(location?: ChatLocation) { return this.base.getExtraHeaders?.(location) ?? {}; }
	getEndpointFetchOptions(): IEndpointFetchOptions { return { suppressIntegrationId: true }; }
	interceptBody(body: IEndpointBody | undefined) { return this.base.interceptBody?.(body); }
	acquireTokenizer() { return this.base.acquireTokenizer(); }
	createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody { return this.base.createRequestBody(options); }
	processResponseFromChatEndpoint(...args: Parameters<IChatEndpoint['processResponseFromChatEndpoint']>) {
		return this.base.processResponseFromChatEndpoint(...args);
	}
	makeChatRequest(...args: Parameters<IChatEndpoint['makeChatRequest']>): Promise<ChatResponse> {
		return this.base.makeChatRequest(...args);
	}

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return this.instantiationService.createInstance(
			CompactLlmOverrideEndpoint,
			this.base.cloneWithTokenOverride(modelMaxPromptTokens),
			this.compactLlmUrl,
		);
	}

	async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		const requestId = generateUuid();
		const normalizedBaseRaw = this.compactLlmUrl.replace(/\/+$/, '');
		const normalizedV1Base = normalizedBaseRaw.endsWith('/v1') ? normalizedBaseRaw : `${normalizedBaseRaw}/v1`;
		const compactUrl = `${normalizedV1Base}/chat/completions`;
		const modelsUrl = `${normalizedV1Base}/models`;
		type SimpleMessage = { role: string; content: string };
		const sanitized: SimpleMessage[] = rawMessageToCAPI(options.messages).flatMap((msg): SimpleMessage[] => {
			const text = getCAPITextPart(msg.content as string | Parameters<typeof getCAPITextPart>[0]);
			switch (msg.role) {
				case 'tool':
				case 'function':
					return [{ role: 'user', content: `[Tool result]\n${text}` }];
				case 'system':
				case 'user':
				case 'assistant':
					return [{ role: msg.role, content: text }];
				default:
					return text ? [{ role: 'user', content: text }] : [];
			}
		});
		const nonSystemMessages = sanitized.filter(m => m.role !== 'system');
		const compactSystemPrompt = await readCompactSystemPrompt();
		const messages = [
			{ role: 'system', content: compactSystemPrompt },
			...nonSystemMessages,
		];
		const truncateForLog = (value: string, max = 1000): string => value.length > max
			? `${value.slice(0, max)}...<truncated ${value.length - max} chars>`
			: value;
		const beforeCompactText = nonSystemMessages
			.map((m, i) => `${i + 1}. [${m.role}] ${m.content}`)
			.join('\n');

		const abort = this.fetcherService.makeAbortController();
		const cancelListener = token.onCancellationRequested(() => abort.abort());
		const fail = async (reason: string): Promise<ChatResponse> => {
			this.logService.warn(`[mem0][compact] ${reason}, falling back to default endpoint`);
			try {
				const baseResponse = await this.base.makeChatRequest2(options, token);
				if (this.traceEnabled) {
					this.logService.debug('[mem0][compact] fallback to base endpoint succeeded');
				}
				return baseResponse;
			} catch (fallbackError) {
				this.logService.error(`[mem0][compact] fallback also failed: ${fallbackError}`);
				return {
					type: ChatFetchResponseType.Failed,
					reason: `${reason}; Fallback error: ${fallbackError}`,
					requestId,
					serverRequestId: undefined,
				};
			}
		};

		try {
			type ModelEntry = { id?: string; default?: boolean; is_default?: boolean; isDefault?: boolean };
			type ModelsResponse = {
				data?: ModelEntry[];
				default_model?: string;
				default?: string;
				model?: string;
			};
			const modelsResponse = await this.fetcherService.fetch(modelsUrl, {
				callSite: NO_FETCH_TELEMETRY,
				method: 'GET',
				signal: abort.signal,
				useFetcher: 'node-http',
			});
			if (!modelsResponse.ok) {
				this.logService.warn(`[mem0][compact] model discovery failed: ${modelsResponse.status} ${modelsResponse.statusText}, url=${modelsUrl}`);
				return await fail(`Model discovery HTTP ${modelsResponse.status}`);
			}

			const modelsData = await modelsResponse.json() as ModelsResponse;
			const discoveredModelId = modelsData.default_model
				?? modelsData.default
				?? modelsData.model
				?? modelsData.data?.find(m => m.default === true || m.is_default === true || m.isDefault === true)?.id
				?? (modelsData.data?.length === 1 ? modelsData.data[0]?.id : undefined);

			if (!discoveredModelId) {
				this.logService.warn('[mem0][compact] request failed: unable to discover default model from /models');
				return await fail('Unable to discover default model');
			}

			if (this.traceEnabled) {
				this.logService.debug(`[mem0][compact] sending request: url=${compactUrl}, model=${discoveredModelId}`);
			}
			const requestStartMs = Date.now();
			const response = await this.fetcherService.fetch(compactUrl, {
				callSite: NO_FETCH_TELEMETRY,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: discoveredModelId,
					messages,
					temperature: options.requestOptions?.temperature ?? 0,
					max_tokens: 10000,
					chat_template_kwargs: { enable_thinking: false },
					thinking: { type: 'disabled' },
					stream: false,
				}),
				signal: abort.signal,
				useFetcher: 'node-http',
			});

			if (token.isCancellationRequested) {
				return { type: ChatFetchResponseType.Canceled, reason: 'canceled', requestId, serverRequestId: undefined };
			}

			if (!response.ok) {
				this.logService.warn(`[mem0][compact] request failed: ${response.status} ${response.statusText}, url=${compactUrl}, model=${discoveredModelId}`);
				return await fail(`HTTP ${response.status}`);
			}

			const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
			const rawContent = data.choices?.[0]?.message?.content ?? '';
			const compactPreamble = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n';
			let content = compactPreamble + rawContent.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
			const elapsedMs = Date.now() - requestStartMs;
			const beforeChars = beforeCompactText.length;
			const afterChars = content.length;
			const reductionRatio = beforeChars > 0
				? ((beforeChars - afterChars) / beforeChars)
				: 0;

			let savedCachePath: string | undefined;
			try {
				const workspaceFolders = this.workspaceService.getWorkspaceFolders();
				if (workspaceFolders.length > 0) {
					const cacheDir = path.join(workspaceFolders[0].fsPath, '.vscode', '.cache');
					await fs.mkdir(cacheDir, { recursive: true });
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
					const cacheFileName = `${COMPACT_CACHE_FILE_PREFIX}${timestamp}-${requestId.slice(0, 8)}.md`;
					savedCachePath = path.join(cacheDir, cacheFileName);
					await fs.writeFile(savedCachePath, beforeCompactText, 'utf-8');
					await pruneCompactCacheFiles(cacheDir, this.logService, this.traceEnabled);
					content = content + `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${savedCachePath}`;
					if (this.traceEnabled) {
						this.logService.debug(`[mem0][compact] saved pre-compact content to ${savedCachePath}`);
					}
				}
			} catch (cacheErr) {
				this.logService.warn(`[mem0][compact] failed to save pre-compact cache: ${cacheErr}`);
			}

			if (this.traceEnabled) {
				this.logService.debug(
					`[mem0][compact] success compare: url=${compactUrl}, model=${discoveredModelId}, elapsedMs=${elapsedMs}, beforeChars=${beforeChars}, afterChars=${afterChars}, reductionRatio=${reductionRatio.toFixed(4)}\n`
					+ `[prompt]\n${truncateForLog(compactSystemPrompt, 100)}\n`
					+ `[before]\n${truncateForLog(beforeCompactText)}\n`
					+ `[after]\n${truncateForLog(content)}`
				);
			}
			if (options.finishedCb) {
				await options.finishedCb(content, 0, { text: content, copilotToolCalls: [] });
			}

			return {
				type: ChatFetchResponseType.Success,
				value: content,
				requestId,
				serverRequestId: undefined,
				usage: data.usage
					? {
						prompt_tokens: data.usage.prompt_tokens ?? 0,
						completion_tokens: data.usage.completion_tokens ?? 0,
						total_tokens: (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0)
					}
					: undefined,
				resolvedModel: discoveredModelId,
			};
		} catch (e) {
			if (token.isCancellationRequested) {
				return { type: ChatFetchResponseType.Canceled, reason: 'canceled', requestId, serverRequestId: undefined };
			}

			return await fail(`local LLM error: ${e}`);
		} finally {
			cancelListener.dispose();
		}
	}
}