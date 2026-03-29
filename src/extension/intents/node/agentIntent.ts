/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw, RenderPromptResult } from '@vscode/prompt-tsx';
import { BudgetExceededError } from '@vscode/prompt-tsx/dist/base/materialized';
import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { isAnthropicFamily, isGptFamily, modelCanUseApplyPatchExclusively, modelCanUseReplaceStringExclusively, modelSupportsApplyPatch, modelSupportsMultiReplaceString, modelSupportsReplaceString, modelSupportsSimplifiedApplyPatchInstructions } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IAutomodeService } from '../../../platform/endpoint/node/automodeService';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { CUSTOM_TOOL_SEARCH_NAME, isAnthropicCustomToolSearchEnabled } from '../../../platform/networking/common/anthropic';
import { IFetcherService, NO_FETCH_TELEMETRY } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IEndpointFetchOptions, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { getCAPITextPart, modelsWithoutResponsesContextManagement, rawMessageToCAPI } from '../../../platform/networking/common/openai';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService } from '../../../platform/tasks/common/tasksService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITestProvider } from '../../../platform/testing/common/testProvider';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Iterable } from '../../../util/vs/base/common/iterator';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';

import { ChatResponseProgressPart2 } from '../../../vscodeTypes';
import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, normalizeSummariesOnRounds, RenderedUserMessageMetadata, TurnStatus } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { getRequestedToolCallIterationLimit, IContinueOnErrorConfirmation } from '../../prompt/common/specialRequestTypes';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IBuildPromptResult, IIntent, IIntentInvocation } from '../../prompt/node/intents';
import { AgentPrompt, AgentPromptProps } from '../../prompts/node/agent/agentPrompt';
import { BackgroundSummarizationState, BackgroundSummarizer, IBackgroundSummarizationResult } from '../../prompts/node/agent/backgroundSummarizer';
import { AgentPromptCustomizations, PromptRegistry } from '../../prompts/node/agent/promptRegistry';
import { SummarizedConversationHistory, SummarizedConversationHistoryMetadata, SummarizedConversationHistoryPropsBuilder } from '../../prompts/node/agent/summarizedConversationHistory';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { EditCodePrompt2 } from '../../prompts/node/panel/editCodePrompt2';
import { NotebookInlinePrompt } from '../../prompts/node/panel/notebookInlinePrompt';
import { ToolResultMetadata } from '../../prompts/node/panel/toolCalling';
import { IEditToolLearningService } from '../../tools/common/editToolLearningService';
import { ContributedToolName, ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { applyPatch5Description } from '../../tools/node/applyPatchTool';
import { getAgentMaxRequests } from '../common/agentConfig';
import { addCacheBreakpoints } from './cacheBreakpoints';
import { EditCodeIntent, EditCodeIntentInvocation, EditCodeIntentInvocationOptions, mergeMetadata, toNewChatReferences } from './editCodeIntent';

function isResponsesCompactionContextManagementEnabled(endpoint: IChatEndpoint, configurationService: IConfigurationService, experimentationService: IExperimentationService): boolean {
	return endpoint.apiType === 'responses'
		&& configurationService.getExperimentBasedConfig(ConfigKey.ResponsesApiContextManagementEnabled, experimentationService)
		&& !modelsWithoutResponsesContextManagement.has(endpoint.family);
}

const COMPACT_SYSTEM_PROMPT_PATH = path.join(__dirname, '../assets/prompts/compactSystemPrompt.md');

async function readCompactSystemPrompt(): Promise<string> {
	return fs.readFile(COMPACT_SYSTEM_PROMPT_PATH, 'utf-8');
}

export const getAgentTools = async (accessor: ServicesAccessor, request: vscode.ChatRequest) => {
	const toolsService = accessor.get<IToolsService>(IToolsService);
	const testService = accessor.get<ITestProvider>(ITestProvider);
	const tasksService = accessor.get<ITasksService>(ITasksService);
	const configurationService = accessor.get<IConfigurationService>(IConfigurationService);
	const experimentationService = accessor.get<IExperimentationService>(IExperimentationService);
	const endpointProvider = accessor.get<IEndpointProvider>(IEndpointProvider);
	const editToolLearningService = accessor.get<IEditToolLearningService>(IEditToolLearningService);
	const model = await endpointProvider.getChatEndpoint(request);

	const allowTools: Record<string, boolean> = {};

	const learned = editToolLearningService.getPreferredEndpointEditTool(model);
	if (learned) {
		allowTools[ToolName.EditFile] = learned.includes(ToolName.EditFile);
		allowTools[ToolName.ReplaceString] = learned.includes(ToolName.ReplaceString);
		allowTools[ToolName.MultiReplaceString] = learned.includes(ToolName.MultiReplaceString);
		allowTools[ToolName.ApplyPatch] = learned.includes(ToolName.ApplyPatch);
	} else {
		allowTools[ToolName.EditFile] = true;
		allowTools[ToolName.ReplaceString] = modelSupportsReplaceString(model);
		allowTools[ToolName.ApplyPatch] = modelSupportsApplyPatch(model) && !!toolsService.getTool(ToolName.ApplyPatch);

		if (allowTools[ToolName.ApplyPatch] && modelCanUseApplyPatchExclusively(model)) {
			allowTools[ToolName.EditFile] = false;
		}

		if (modelCanUseReplaceStringExclusively(model)) {
			allowTools[ToolName.ReplaceString] = true;
			allowTools[ToolName.EditFile] = false;
		}

		if (allowTools[ToolName.ReplaceString] && modelSupportsMultiReplaceString(model)) {
			allowTools[ToolName.MultiReplaceString] = true;
		}
	}

	allowTools[ToolName.CoreRunTest] = await testService.hasAnyTests();
	allowTools[ToolName.CoreRunTask] = tasksService.getTasks().length > 0;

	const searchSubagentEnabled = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.SearchSubagentToolEnabled, experimentationService);
	const isGptOrAnthropic = isGptFamily(model) || isAnthropicFamily(model);
	allowTools[ToolName.SearchSubagent] = isGptOrAnthropic && searchSubagentEnabled;

	const executionSubagentEnabled = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.ExecutionSubagentToolEnabled, experimentationService);
	allowTools[ToolName.ExecutionSubagent] = isGptOrAnthropic && executionSubagentEnabled;

	if (model.family.includes('grok-code')) {
		allowTools[ToolName.CoreManageTodoList] = false;
	}

	allowTools['task_complete'] = request.permissionLevel === 'autopilot';

	allowTools[ToolName.EditFilesPlaceholder] = false;
	if (Iterable.some(request.tools, ([t, enabled]) => (typeof t === 'string' ? t : t.name) === ContributedToolName.EditFilesPlaceholder && enabled === false)) {
		allowTools[ToolName.ApplyPatch] = false;
		allowTools[ToolName.EditFile] = false;
		allowTools[ToolName.ReplaceString] = false;
		allowTools[ToolName.MultiReplaceString] = false;
	}

	if (model.family.toLowerCase().includes('gemini-3') && configurationService.getExperimentBasedConfig(ConfigKey.Advanced.Gemini3MultiReplaceString, experimentationService)) {
		allowTools[ToolName.MultiReplaceString] = true;
	}

	allowTools[CUSTOM_TOOL_SEARCH_NAME] = isAnthropicCustomToolSearchEnabled(model, configurationService, experimentationService);

	const tools = toolsService.getEnabledTools(request, model, tool => {
		if (typeof allowTools[tool.name] === 'boolean') {
			return allowTools[tool.name];
		}

		return undefined;
	});

	if (modelSupportsSimplifiedApplyPatchInstructions(model) && configurationService.getExperimentBasedConfig(ConfigKey.Advanced.Gpt5AlternativePatch, experimentationService)) {
		const ap = tools.findIndex(t => t.name === ToolName.ApplyPatch);
		if (ap !== -1) {
			tools[ap] = { ...tools[ap], description: applyPatch5Description };
		}
	}

	return tools;
};

export class AgentIntent extends EditCodeIntent {

	static override readonly ID = Intent.Agent;

	override readonly id = AgentIntent.ID;

	private readonly _backgroundSummarizers = new Map<string, BackgroundSummarizer>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IChatSessionService chatSessionService: IChatSessionService,
		@IAutomodeService private readonly _automodeService: IAutomodeService,
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { intentInvocation: AgentIntentInvocation, processCodeblocks: false });
		chatSessionService.onDidDisposeChatSession(sessionId => {
			const summarizer = this._backgroundSummarizers.get(sessionId);
			if (summarizer) {
				summarizer.cancel();
				this._backgroundSummarizers.delete(sessionId);
			}
		});
	}

	getOrCreateBackgroundSummarizer(sessionId: string, modelMaxPromptTokens: number): BackgroundSummarizer {
		let summarizer = this._backgroundSummarizers.get(sessionId);
		if (!summarizer) {
			summarizer = new BackgroundSummarizer(modelMaxPromptTokens);
			this._backgroundSummarizers.set(sessionId, summarizer);
		}
		return summarizer;
	}

	protected override getIntentHandlerOptions(request: vscode.ChatRequest): IDefaultIntentRequestHandlerOptions | undefined {
		return {
			maxToolCallIterations: getRequestedToolCallIterationLimit(request) ??
				this.instantiationService.invokeFunction(getAgentMaxRequests),
			temperature: this.configurationService.getConfig(ConfigKey.Advanced.AgentTemperature) ?? 0,
			overrideRequestLocation: ChatLocation.Agent
		};
	}

	override async handleRequest(
		conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		documentContext: IDocumentContext | undefined,
		agentName: string,
		location: ChatLocation,
		chatTelemetry: ChatTelemetryBuilder,
		yieldRequested: () => boolean
	): Promise<vscode.ChatResult> {
		if (request.command === 'compact') {
			return this.handleSummarizeCommand(conversation, request, stream, token);
		}

		return super.handleRequest(conversation, request, stream, token, documentContext, agentName, location, chatTelemetry, yieldRequested);
	}

	private async handleSummarizeCommand(
		conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		normalizeSummariesOnRounds(conversation.turns);

		// Exclude the current /compact turn.
		const history = conversation.turns.slice(0, -1);
		if (history.length === 0) {
			stream.markdown(l10n.t('Nothing to compact. Start a conversation first.'));
			return {};
		}

		// The summarization metadata needs to be associated with a tool call round.
		const lastRoundId = history.at(-1)?.rounds.at(-1)?.id;
		if (!lastRoundId) {
			stream.markdown(l10n.t('Nothing to compact. Start a conversation with tool calls first.'));
			return {};
		}

		const endpoint = await this.endpointProvider.getChatEndpoint(request);
		if (isResponsesCompactionContextManagementEnabled(endpoint, this.configurationService, this.expService)) {
			stream.markdown(l10n.t('Compaction is already managed by context management for this session.'));
			return {};
		}

		const mem0Enabled = this.configurationService.getConfig(ConfigKey.Mem0Enabled) ?? false;
		const compactLlmUrl = mem0Enabled ? this.configurationService.getConfig(ConfigKey.CompactLlmEndpoint)?.trim() : undefined;
		const compactEndpoint = compactLlmUrl
			? this.instantiationService.createInstance(CompactLlmOverrideEndpoint, endpoint, compactLlmUrl)
			: endpoint;

		const promptContext: IBuildPromptContext = {
			history,
			chatVariables: new ChatVariablesCollection([]),
			query: '',
			toolCallRounds: [],
			conversation,
		};

		try {
			const propsBuilder = this.instantiationService.createInstance(SummarizedConversationHistoryPropsBuilder);
			const propsInfo = propsBuilder.getProps({
				priority: 1,
				endpoint: compactEndpoint,
				location: ChatLocation.Agent,
				promptContext,
				maxToolResultLength: Infinity,
			});

			stream.progress(l10n.t('Compacting conversation...'));

			const progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart> = {
				report: () => { }
			};
			const renderer = PromptRenderer.create(this.instantiationService, compactEndpoint, SummarizedConversationHistory, {
				...propsInfo.props,
				triggerSummarize: true,
				summarizationInstructions: request.prompt || undefined,
			});
			const result = await renderer.render(progress, token);
			const summaryMetadata = result.metadata.get(SummarizedConversationHistoryMetadata);
			if (!summaryMetadata) {
				stream.markdown(l10n.t('Unable to compact conversation.'));
				return {};
			}

			if (summaryMetadata.usage) {
				stream.usage({
					promptTokens: summaryMetadata.usage.prompt_tokens,
					completionTokens: summaryMetadata.usage.completion_tokens,
					promptTokenDetails: summaryMetadata.promptTokenDetails,
				});
			}

			stream.markdown(l10n.t('Compacted conversation.'));
			const lastTurn = conversation.getLatestTurn();
			// Next turn if using auto will select a new endpoint.
			this._automodeService.invalidateRouterCache(request);

			const chatResult: vscode.ChatResult = {
				...(compactLlmUrl ? { details: 'Smart Compact' } : {}),
				metadata: {
					summary: {
						toolCallRoundId: summaryMetadata.toolCallRoundId,
						text: summaryMetadata.text,
					}
				}
			};

			lastTurn.setResponse(
				TurnStatus.Success,
				{ type: 'model', message: '' },
				undefined,
				chatResult,
			);

			lastTurn.setMetadata(summaryMetadata);

			return chatResult;
		} catch (e) {
			if (isCancellationError(e)) {
				return {};
			}

			const message = e instanceof Error ? e.message : String(e);
			stream.markdown(l10n.t('Failed to compact conversation: {0}', message));
			return {};
		}
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
		// Sanitize messages for the local LLM:
		// - Stringify array content (the CAPI format allows content arrays)
		// - Strip CAPI-specific extra fields (copilot_references, copilot_cache_control, etc.)
		// - Convert `tool` / `function` role messages to `user` messages
		// - Strip tool_calls from assistant messages
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
				if (this.traceEnabled) { this.logService.info(`[mem0][compact] fallback to base endpoint succeeded`); }
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

			if (this.traceEnabled) { this.logService.debug(`[mem0][compact] sending request: url=${compactUrl}, model=${discoveredModelId}`); }
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
			// Strip thinking/reasoning blocks that some local LLMs emit despite being asked not to.
			// Handles <think>...</think>, <thinking>...</thinking>, and <reasoning>...</reasoning>.
			const COMPACT_PREAMBLE = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n';
			let content = COMPACT_PREAMBLE + rawContent.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
			const elapsedMs = Date.now() - requestStartMs;
			const beforeChars = beforeCompactText.length;
			const afterChars = content.length;
			const reductionRatio = beforeChars > 0
				? ((beforeChars - afterChars) / beforeChars)
				: 0;

			// Save original pre-compact content to workspace .cache/ for future reference
			let savedCachePath: string | undefined;
			try {
				const workspaceFolders = this.workspaceService.getWorkspaceFolders();
				if (workspaceFolders.length > 0) {
					const cacheDir = path.join(workspaceFolders[0].fsPath, '.cache');
					await fs.mkdir(cacheDir, { recursive: true });
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
					const cacheFileName = `compact-pre-${timestamp}-${requestId.slice(0, 8)}.md`;
					savedCachePath = path.join(cacheDir, cacheFileName);
					await fs.writeFile(savedCachePath, beforeCompactText, 'utf-8');
					content = content + `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${savedCachePath}`;
					if (this.traceEnabled) { this.logService.info(`[mem0][compact] saved pre-compact content to ${savedCachePath}`); }
				}
			} catch (cacheErr) {
				this.logService.warn(`[mem0][compact] failed to save pre-compact cache: ${cacheErr}`);
			}

			if (this.traceEnabled) {
				this.logService.info(
					`[mem0][compact] success compare: url=${compactUrl}, model=${discoveredModelId}, elapsedMs=${elapsedMs}, beforeChars=${beforeChars}, afterChars=${afterChars}, reductionRatio=${reductionRatio.toFixed(4)}\n` +
					`[prompt]\n${truncateForLog(compactSystemPrompt, 100)}\n` +
					`[before]\n${truncateForLog(beforeCompactText)}\n` +
					`[after]\n${truncateForLog(content)}`
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

export class AgentIntentInvocation extends EditCodeIntentInvocation implements IIntentInvocation {

	public override readonly codeblocksRepresentEdits = false;

	protected prompt: typeof AgentPrompt | typeof EditCodePrompt2 | typeof NotebookInlinePrompt = AgentPrompt;

	protected extraPromptProps: Partial<AgentPromptProps> | undefined;

	private _resolvedCustomizations: AgentPromptCustomizations | undefined;

	private _lastRenderTokenCount: number = 0;

	constructor(
		intent: IIntent,
		location: ChatLocation,
		endpoint: IChatEndpoint,
		request: vscode.ChatRequest,
		intentOptions: EditCodeIntentInvocationOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IEnvService envService: IEnvService,
		@IPromptPathRepresentationService promptPathRepresentationService: IPromptPathRepresentationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IToolsService toolsService: IToolsService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditLogService editLogService: IEditLogService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotebookService notebookService: INotebookService,
		@ILogService private readonly logService: ILogService,
		@IExperimentationService private readonly expService: IExperimentationService,
		@IAutomodeService private readonly automodeService: IAutomodeService,
	) {
		super(intent, location, endpoint, request, intentOptions, instantiationService, codeMapperService, envService, promptPathRepresentationService, endpointProvider, workspaceService, toolsService, configurationService, editLogService, commandService, telemetryService, notebookService);
	}

	public override getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return this.instantiationService.invokeFunction(getAgentTools, this.request);
	}

	override async buildPrompt(
		promptContext: IBuildPromptContext,
		progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>,
		token: vscode.CancellationToken
	): Promise<IBuildPromptResult> {
		this._resolvedCustomizations = await PromptRegistry.resolveAllCustomizations(this.instantiationService, this.endpoint);
		const codebase = await this._getCodebaseReferences(promptContext, token);

		let variables = promptContext.chatVariables;
		let toolReferences: vscode.ChatPromptReference[] = [];
		if (codebase) {
			toolReferences = toNewChatReferences(variables, codebase.references);
			variables = new ChatVariablesCollection([...this.request.references, ...toolReferences]);
		}

		const tools = promptContext.tools?.availableTools;
		const toolTokens = tools?.length ? await this.endpoint.acquireTokenizer().countToolTokens(tools) : 0;

		const summarizeThresholdOverride = this.configurationService.getConfig<number | undefined>(ConfigKey.Advanced.SummarizeAgentConversationHistoryThreshold);
		if (typeof summarizeThresholdOverride === 'number' && summarizeThresholdOverride < 100 && summarizeThresholdOverride > 0) {
			throw new Error(`Setting github.copilot.${ConfigKey.Advanced.SummarizeAgentConversationHistoryThreshold.id} is too low`);
		}

		const baseBudget = Math.min(
			this.configurationService.getConfig<number | undefined>(ConfigKey.Advanced.SummarizeAgentConversationHistoryThreshold) ?? this.endpoint.modelMaxPromptTokens,
			this.endpoint.modelMaxPromptTokens
		);
		const useTruncation = this.endpoint.apiType === 'responses' && this.configurationService.getConfig(ConfigKey.Advanced.UseResponsesApiTruncation);
		const responsesCompactionContextManagementEnabled = isResponsesCompactionContextManagementEnabled(this.endpoint, this.configurationService, this.expService);
		const summarizationEnabled = this.configurationService.getConfig(ConfigKey.SummarizeAgentConversationHistory) && this.prompt === AgentPrompt && !responsesCompactionContextManagementEnabled;
		const backgroundCompactionEnabled = summarizationEnabled && this.configurationService.getExperimentBasedConfig(ConfigKey.BackgroundCompaction, this.expService);

		const budgetThreshold = Math.floor((baseBudget - toolTokens) * 0.85);
		const safeBudget = useTruncation ? Number.MAX_SAFE_INTEGER : budgetThreshold;
		const endpoint = toolTokens > 0 ? this.endpoint.cloneWithTokenOverride(safeBudget) : this.endpoint;

		this.logService.debug(`AgentIntent: rendering with budget=${safeBudget} (baseBudget: ${baseBudget}, toolTokens: ${toolTokens}), summarizationEnabled=${summarizationEnabled}`);
		let result: RenderPromptResult;
		const props: AgentPromptProps = {
			endpoint,
			promptContext: {
				...promptContext,
				tools: promptContext.tools && {
					...promptContext.tools,
					toolReferences: this.stableToolReferences.filter((r) => r.name !== ToolName.Codebase),
				}
			},
			location: this.location,
			enableCacheBreakpoints: summarizationEnabled,
			...this.extraPromptProps,
			customizations: this._resolvedCustomizations
		};

		// -- Background compaction: dual-threshold approach --
		//
		// Background compaction thresholds (checked post-render using the
		// actual tokenCount from the current render):
		//
		//   Completed (previous background pass) -> apply the summary before rendering.
		//   >= 95% + InProgress                 -> block on background compaction, then apply.
		//   >= 75% + Idle (post-render)         -> kick off background compaction.

		const backgroundSummarizer = backgroundCompactionEnabled ? this._getOrCreateBackgroundSummarizer(promptContext.conversation?.sessionId) : undefined;
		const contextRatio = backgroundSummarizer && budgetThreshold > 0
			? this._lastRenderTokenCount / budgetThreshold
			: 0;

		let summaryAppliedThisIteration = false;

		// 1. If a previous background pass completed, apply its summary now.
		if (backgroundCompactionEnabled && backgroundSummarizer?.state === BackgroundSummarizationState.Completed) {
			const bgResult = backgroundSummarizer.consumeAndReset();
			if (bgResult) {
				this.logService.debug(`[Agent] applying completed background summary (roundId=${bgResult.toolCallRoundId})`);
				progress.report(new ChatResponseProgressPart2(l10n.t('Compacted conversation'), async () => l10n.t('Compacted conversation')));
				this._applySummaryToRounds(bgResult, promptContext);
				this._persistSummaryOnTurn(bgResult, promptContext, this._lastRenderTokenCount);
				this._sendBackgroundCompactionTelemetry('preRender', 'applied', contextRatio, promptContext);
				summaryAppliedThisIteration = true;
			}
		}
		// 2. At >= 95%: block and wait for in-progress compaction,
		// then apply the result before rendering.
		if (backgroundCompactionEnabled && backgroundSummarizer && contextRatio >= 0.95 && backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
			this.logService.debug(`[Agent] context at ${(contextRatio * 100).toFixed(0)}% — blocking on background compaction`);
			const summaryPromise = backgroundSummarizer.waitForCompletion();
			progress.report(new ChatResponseProgressPart2(l10n.t('Compacting conversation...'), async () => {
				try { await summaryPromise; } catch { }
				return l10n.t('Compacted conversation');
			}));
			await summaryPromise;
			const bgResult = backgroundSummarizer.consumeAndReset();
			if (bgResult) {
				this.logService.debug(`[Agent] background compaction completed — applying result (roundId=${bgResult.toolCallRoundId})`);
				this._applySummaryToRounds(bgResult, promptContext);
				this._persistSummaryOnTurn(bgResult, promptContext, this._lastRenderTokenCount);
				this._sendBackgroundCompactionTelemetry('preRenderBlocked', 'applied', contextRatio, promptContext);
				summaryAppliedThisIteration = true;
			} else {
				this.logService.debug(`[Agent] background compaction finished but produced no usable result`);
				this._sendBackgroundCompactionTelemetry('preRenderBlocked', 'noResult', contextRatio, promptContext);
			}
		}

		// Helper function for synchronous summarization flow with fallbacks
		const renderWithSummarization = async (reason: string, renderProps: AgentPromptProps = props): Promise<RenderPromptResult> => {
			this.logService.debug(`[Agent] ${reason}, triggering summarization`);
			try {
				const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
					...renderProps,
					triggerSummarize: true,
				});
				return await renderer.render(progress, token);
			} catch (e) {
				this.logService.error(e, `[Agent] summarization failed`);
				const errorKind = e instanceof BudgetExceededError ? 'budgetExceeded' : 'error';
				/* __GDPR__
					"triggerSummarizeFailed" : {
						"owner": "roblourens",
						"comment": "Tracks when triggering summarization failed - for example, a summary was created but not applied successfully.",
						"errorKind": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The success state or failure reason of the summarization." },
						"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used for the summarization." }
					}
				*/
				this.telemetryService.sendMSFTTelemetryEvent('triggerSummarizeFailed', { errorKind, model: renderProps.endpoint.model });

				// Track failed foreground compaction
				const turn = promptContext.conversation?.getLatestTurn();
				turn?.setMetadata(new SummarizedConversationHistoryMetadata(
					'', // no toolCallRoundId for failures
					'', // no summary text for failures
					{
						model: renderProps.endpoint.model,
						source: 'foreground',
						outcome: errorKind,
						contextLengthBefore: this._lastRenderTokenCount,
					},
				));

				// Something else went wrong, eg summarization failed, so render the prompt with no cache breakpoints, summarization, endpoint not reduced in size for tools or safety buffer
				const renderer = PromptRenderer.create(this.instantiationService, this.endpoint, this.prompt, {
					...renderProps,
					endpoint: this.endpoint,
					enableCacheBreakpoints: false
				});
				try {
					return await renderer.render(progress, token);
				} catch (e) {
					if (e instanceof BudgetExceededError) {
						this.logService.error(e, `[Agent] final render fallback failed due to budget exceeded`);
						const maxTokens = this.endpoint.modelMaxPromptTokens;
						throw new Error(`Unable to build prompt, modelMaxPromptTokens = ${maxTokens} (${e.message})`);
					}
					throw e;
				}
			}
		};

		const contextLengthBefore = this._lastRenderTokenCount;

		try {
			const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, props);
			result = await renderer.render(progress, token);
		} catch (e) {
			if (e instanceof BudgetExceededError && summarizationEnabled) {
				if (!promptContext.toolCallResults) {
					promptContext = {
						...promptContext,
						toolCallResults: {}
					};
				}
				e.metadata.getAll(ToolResultMetadata).forEach((metadata) => {
					promptContext.toolCallResults![metadata.toolCallId] = metadata.result;
				});

				// If a background compaction is already running or completed,
				// wait for / apply it instead of firing another LLM request.
				if (backgroundSummarizer && (backgroundSummarizer.state === BackgroundSummarizationState.InProgress || backgroundSummarizer.state === BackgroundSummarizationState.Completed)) {
					let budgetExceededTrigger: string;
					if (backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
						budgetExceededTrigger = 'budgetExceededWaited';
						this.logService.debug(`[Agent] budget exceeded — waiting on in-progress background compaction instead of new request`);
						const summaryPromise = backgroundSummarizer.waitForCompletion();
						progress.report(new ChatResponseProgressPart2(l10n.t('Compacting conversation...'), async () => {
							try { await summaryPromise; } catch { }
							return l10n.t('Compacted conversation');
						}));
						await summaryPromise;
					} else {
						budgetExceededTrigger = 'budgetExceededReady';
						this.logService.debug(`[Agent] budget exceeded — applying already-completed background compaction`);
						progress.report(new ChatResponseProgressPart2(l10n.t('Compacted conversation'), async () => l10n.t('Compacted conversation')));
					}
					const bgResult = backgroundSummarizer.consumeAndReset();
					if (bgResult) {
						this.logService.debug(`[Agent] background compaction applied after budget exceeded (roundId=${bgResult.toolCallRoundId})`);
						this._applySummaryToRounds(bgResult, promptContext);
						this._persistSummaryOnTurn(bgResult, promptContext, contextLengthBefore);
						this._sendBackgroundCompactionTelemetry(budgetExceededTrigger, 'applied', contextRatio, promptContext);
						summaryAppliedThisIteration = true;
						// Re-render with the compacted history
						const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, { ...props, promptContext });
						result = await renderer.render(progress, token);
					} else {
						this.logService.debug(`[Agent] background compaction produced no usable result after budget exceeded — falling back to synchronous summarization`);
						this._sendBackgroundCompactionTelemetry(budgetExceededTrigger, 'noResult', contextRatio, promptContext);
						// Background compaction failed — fall back to synchronous summarization
						result = await renderWithSummarization(`budget exceeded(${e.message}), background compaction failed`);
					}
				} else {
					result = await renderWithSummarization(`budget exceeded(${e.message})`);
				}
			} else {
				throw e;
			}
		}

		this._lastRenderTokenCount = result.tokenCount;

		// Track foreground compaction if summarization happened during rendering
		const summaryMeta = result.metadata.get(SummarizedConversationHistoryMetadata);
		if (summaryMeta) {
			const turn = promptContext.conversation?.getLatestTurn();
			turn?.setMetadata(new SummarizedConversationHistoryMetadata(
				summaryMeta.toolCallRoundId,
				summaryMeta.text,
				{
					thinking: summaryMeta.thinking,
					usage: summaryMeta.usage,
					promptTokenDetails: summaryMeta.promptTokenDetails,
					model: summaryMeta.model,
					summarizationMode: summaryMeta.summarizationMode,
					numRounds: summaryMeta.numRounds,
					numRoundsSinceLastSummarization: summaryMeta.numRoundsSinceLastSummarization,
					durationMs: summaryMeta.durationMs,
					source: 'foreground',
					outcome: 'success',
					contextLengthBefore,
				},
			));
		}

		// 3. Post-render background compaction checks.
		if (backgroundCompactionEnabled && backgroundSummarizer && !summaryAppliedThisIteration) {
			const postRenderRatio = budgetThreshold > 0
				? result.tokenCount / budgetThreshold
				: 0;

			if (postRenderRatio >= 0.95 && backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
				// At ≥ 95% with a background compaction already running — block,
				// wait for it, apply the result, and re-render so the LLM gets
				// the compacted prompt instead of the oversized one.
				this.logService.debug(`[Agent] post-render at ${(postRenderRatio * 100).toFixed(0)}% — blocking on in-progress background compaction`);
				const summaryPromise = backgroundSummarizer.waitForCompletion();
				progress.report(new ChatResponseProgressPart2(l10n.t('Compacting conversation...'), async () => {
					try { await summaryPromise; } catch { }
					return l10n.t('Compacted conversation');
				}));
				await summaryPromise;
				const bgResult = backgroundSummarizer.consumeAndReset();
				if (bgResult) {
					this.logService.debug(`[Agent] post-render background compaction completed — applying result and re-rendering (roundId=${bgResult.toolCallRoundId})`);
					this._applySummaryToRounds(bgResult, promptContext);
					this._persistSummaryOnTurn(bgResult, promptContext, result.tokenCount);
					this._sendBackgroundCompactionTelemetry('postRenderBlocked', 'applied', postRenderRatio, promptContext);
					// Re-render with compacted history so the LLM receives the smaller prompt
					const reRenderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, { ...props, promptContext });
					result = await reRenderer.render(progress, token);
					this._lastRenderTokenCount = result.tokenCount;
				} else {
					this.logService.debug(`[Agent] post-render background compaction finished but produced no usable result`);
					this._sendBackgroundCompactionTelemetry('postRenderBlocked', 'noResult', postRenderRatio, promptContext);
				}
			} else if (postRenderRatio >= 0.75 && (backgroundSummarizer.state === BackgroundSummarizationState.Idle || backgroundSummarizer.state === BackgroundSummarizationState.Failed)) {
				// At ≥ 75% with no running compaction (or a previous failure) — kick off background work.
				this._startBackgroundSummarization(backgroundSummarizer, props, endpoint, token, postRenderRatio);
			}
		}

		const lastMessage = result.messages.at(-1);
		if (lastMessage?.role === Raw.ChatRole.User) {
			const currentTurn = promptContext.conversation?.getLatestTurn();
			if (currentTurn && !currentTurn.getMetadata(RenderedUserMessageMetadata)) {
				currentTurn.setMetadata(new RenderedUserMessageMetadata(lastMessage.content));
			}
		}

		addCacheBreakpoints(result.messages);

		if (this.request.command === 'error') {
			// Should trigger a 400
			result.messages.push({
				role: Raw.ChatRole.Assistant,
				content: [],
				toolCalls: [{ type: 'function', id: '', function: { name: 'tool', arguments: '{' } }]
			});
		}


		return {
			...result,
			// The codebase tool is not actually called/referenced in the edit prompt, so we ned to
			// merge its metadata so that its output is not lost and it's not called repeatedly every turn
			// todo@connor4312/joycerhl: this seems a bit janky
			metadata: codebase ? mergeMetadata(result.metadata, codebase.metadatas) : result.metadata,
			// Don't report file references that came in via chat variables in an editing session, unless they have warnings,
			// because they are already displayed as part of the working set
			// references: result.references.filter((ref) => this.shouldKeepReference(editCodeStep, ref, toolReferences, chatVariables)),
		};
	}

	modifyErrorDetails(errorDetails: vscode.ChatErrorDetails, response: ChatResponse): vscode.ChatErrorDetails {
		if (!errorDetails.responseIsFiltered) {
			errorDetails.confirmationButtons = [
				...(errorDetails.confirmationButtons ?? []),
				{ data: { copilotContinueOnError: true } satisfies IContinueOnErrorConfirmation, label: l10n.t('Try Again') },
			];
		}
		return errorDetails;
	}

	getAdditionalVariables(promptContext: IBuildPromptContext): ChatVariablesCollection | undefined {
		const lastTurn = promptContext.conversation?.turns.at(-1);
		if (!lastTurn) {
			return;
		}

		// Search backwards to find the first real request and return those variables too.
		// Variables aren't re-attached to requests from confirmations.
		// TODO https://github.com/microsoft/vscode/issues/262858, more to do here
		if (lastTurn.acceptedConfirmationData) {
			const turns = promptContext.conversation!.turns.slice(0, -1);
			for (const turn of Iterable.reverse(turns)) {
				if (!turn.acceptedConfirmationData) {
					return turn.promptVariables;
				}
			}
		}
	}

	private _startBackgroundSummarization(
		backgroundSummarizer: BackgroundSummarizer,
		props: AgentPromptProps,
		endpoint: IChatEndpoint,
		token: vscode.CancellationToken,
		contextRatio: number,
	): void {
		this.logService.debug(`[Agent] context at ${(contextRatio * 100).toFixed(0)}% — starting background compaction`);
		const snapshotProps: AgentPromptProps = { ...props, promptContext: { ...props.promptContext } };
		const bgRenderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
			...snapshotProps,
			triggerSummarize: true,
			summarizationSource: 'background',
		});
		const bgProgress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart> = { report: () => { } };
		const bgStartTime = Date.now();
		backgroundSummarizer.start(async bgToken => {
			try {
				const bgRenderResult = await bgRenderer.render(bgProgress, bgToken);
				const summaryMetadata = bgRenderResult.metadata.get(SummarizedConversationHistoryMetadata);
				if (!summaryMetadata) {
					throw new Error('Background compaction produced no summary metadata');
				}
				this.logService.debug(`[Agent] background compaction completed successfully (roundId=${summaryMetadata.toolCallRoundId})`);
				return {
					summary: summaryMetadata.text,
					toolCallRoundId: summaryMetadata.toolCallRoundId,
					promptTokens: summaryMetadata.usage?.prompt_tokens,
					promptCacheTokens: summaryMetadata.usage?.prompt_tokens_details?.cached_tokens,
					outputTokens: summaryMetadata.usage?.completion_tokens,
					durationMs: Date.now() - bgStartTime,
					model: summaryMetadata.model,
					summarizationMode: summaryMetadata.summarizationMode,
					numRounds: summaryMetadata.numRounds,
					numRoundsSinceLastSummarization: summaryMetadata.numRoundsSinceLastSummarization,
				};
			} catch (err) {
				this.logService.error(err, `[Agent] background compaction failed`);
				throw err;
			}
		}, token);
	}

	/**
	 * Returns the `BackgroundSummarizer` for this session, or `undefined` if
	 * the intent is not an `AgentIntent` (e.g. `AskAgentIntent`).
	 */
	private _getOrCreateBackgroundSummarizer(sessionId: string | undefined): BackgroundSummarizer | undefined {
		if (!sessionId || !(this.intent instanceof AgentIntent)) {
			return undefined;
		}
		return this.intent.getOrCreateBackgroundSummarizer(sessionId, this.endpoint.modelMaxPromptTokens);
	}

	/**
	 * Apply a background-compaction result onto the in-memory rounds so
	 * that the next render picks up the `<conversation-summary>` element.
	 */
	private _applySummaryToRounds(bgResult: { summary: string; toolCallRoundId: string }, promptContext: IBuildPromptContext): void {
		// Check current-turn rounds first
		const currentRound = promptContext.toolCallRounds?.find(r => r.id === bgResult.toolCallRoundId);
		if (currentRound) {
			currentRound.summary = bgResult.summary;
		} else {
			// Fall back to history turns
			for (const turn of [...promptContext.history].reverse()) {
				const round = turn.rounds.find(r => r.id === bgResult.toolCallRoundId);
				if (round) {
					round.summary = bgResult.summary;
					break;
				}
			}
		}
		// Invalidate the auto mode router cache so the next getChatEndpoint()
		// call re-evaluates which model to use after compaction.
		this.automodeService.invalidateRouterCache(this.request);
	}

	/**
	 * Persist the summary on the current turn's `resultMetadata` so that
	 * `normalizeSummariesOnRounds` restores it on subsequent turns.
	 */
	private _persistSummaryOnTurn(bgResult: IBackgroundSummarizationResult, promptContext: IBuildPromptContext, contextLengthBefore?: number): void {
		const turn = promptContext.conversation?.getLatestTurn();
		const chatResult = turn?.responseChatResult;
		if (chatResult) {
			const metadata = (chatResult.metadata ?? {}) as Record<string, unknown>;
			const existingSummaries = (metadata['summaries'] as unknown[] ?? []);
			existingSummaries.push({ toolCallRoundId: bgResult.toolCallRoundId, text: bgResult.summary });
			metadata['summaries'] = existingSummaries;
			(chatResult as { metadata: unknown }).metadata = metadata;
		}
		const usage = bgResult.promptTokens !== undefined && bgResult.outputTokens !== undefined
			? { prompt_tokens: bgResult.promptTokens, completion_tokens: bgResult.outputTokens, total_tokens: bgResult.promptTokens + bgResult.outputTokens, ...(bgResult.promptCacheTokens !== undefined ? { prompt_tokens_details: { cached_tokens: bgResult.promptCacheTokens } } : {}) }
			: undefined;
		turn?.setMetadata(new SummarizedConversationHistoryMetadata(
			bgResult.toolCallRoundId,
			bgResult.summary,
			{
				usage,
				model: bgResult.model,
				summarizationMode: bgResult.summarizationMode,
				numRounds: bgResult.numRounds,
				numRoundsSinceLastSummarization: bgResult.numRoundsSinceLastSummarization,
				durationMs: bgResult.durationMs,
				source: 'background',
				outcome: 'success',
				contextLengthBefore,
			},
		));
	}

	private _sendBackgroundCompactionTelemetry(
		trigger: string,
		outcome: string,
		contextRatio: number,
		promptContext: IBuildPromptContext,
	): void {
		/* __GDPR__
			"backgroundSummarizationApplied" : {
				"owner": "bhavyau",
				"comment": "Tracks background compaction orchestration decisions and outcomes in the agent loop.",
				"trigger": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The code path that triggered background compaction consumption." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the background compaction result was applied or produced no usable result." },
				"conversationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for the current chat conversation." },
				"chatRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The chat request ID that this background compaction was consumed during." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used." },
				"contextRatio": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The context window usage ratio when background compaction was consumed." }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('backgroundSummarizationApplied', {
			trigger,
			outcome,
			conversationId: promptContext.conversation?.sessionId,
			chatRequestId: promptContext.conversation?.getLatestTurn()?.id,
			model: this.endpoint.model,
		}, {
			contextRatio,
		});
	}

	override processResponse = undefined;
}
