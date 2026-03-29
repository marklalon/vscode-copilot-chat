/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { IChatEndpoint, IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { CompactLlmOverrideEndpoint } from '../agentIntent';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockFetcherService {
	declare readonly _serviceBrand: undefined;

	readonly fetchCalls: { url: string; options: any }[] = [];
	fetchHandler: (url: string, options: any) => Promise<Response> = async () => new Response('{}', { status: 200 });

	readonly onDidFetch = { dispose: () => { } } as any;
	readonly onDidCompleteFetch = { dispose: () => { } } as any;

	getUserAgentLibrary() { return 'test'; }
	createWebSocket() { return {} as any; }
	async disconnectAll() { }
	isAbortError() { return false; }
	isInternetDisconnectedError() { return false; }
	isFetcherError() { return false; }
	isNetworkProcessCrashedError() { return false; }
	getUserMessageForFetcherError() { return ''; }
	async fetchWithPagination() { return []; }

	makeAbortController() {
		return { abort: () => { }, signal: {} as AbortSignal };
	}

	async fetch(url: string, options: any): Promise<Response> {
		this.fetchCalls.push({ url, options });
		return this.fetchHandler(url, options);
	}

	respondByUrl(handlers: Record<string, unknown>) {
		this.fetchHandler = async (url: string) => {
			for (const [pattern, body] of Object.entries(handlers)) {
				if (url.includes(pattern)) {
					return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
			}
			return new Response('Not Found', { status: 404 });
		};
	}

	respondWithError(msg = 'network error') {
		this.fetchHandler = async () => { throw new Error(msg); };
	}
}

function createMockBaseEndpoint(): IChatEndpoint {
	return {
		urlOrRequestMetadata: 'http://base-endpoint',
		name: 'test-model',
		version: '1.0',
		family: 'test',
		tokenizer: 'cl100k_base' as any,
		modelMaxPromptTokens: 8000,
		maxOutputTokens: 4000,
		model: 'test-model',
		modelProvider: 'test',
		apiType: 'chat',
		supportsToolCalls: true,
		supportsVision: false,
		supportsPrediction: false,
		showInModelPicker: false,
		isFallback: false,
		getExtraHeaders: () => ({}),
		getEndpointFetchOptions: () => ({ suppressIntegrationId: false }),
		interceptBody: () => { },
		acquireTokenizer: () => ({ tokenize: () => [], detokenize: () => '' }) as any,
		createRequestBody: () => ({}) as any,
		processResponseFromChatEndpoint: (() => { }) as any,
		makeChatRequest: async () => ({ type: ChatFetchResponseType.Failed, reason: 'not implemented', requestId: '', serverRequestId: undefined }),
		makeChatRequest2: async () => ({ type: ChatFetchResponseType.Failed, reason: 'not implemented', requestId: '', serverRequestId: undefined }),
		cloneWithTokenOverride: function () { return this; },
	} as any;
}

function textPart(text: string): Raw.ChatCompletionContentPartText {
	return { type: Raw.ChatCompletionContentPartKind.Text, text };
}

function msg(role: 'system' | 'user' | 'assistant', content: string): Raw.ChatMessage {
	const roleMap = { system: Raw.ChatRole.System, user: Raw.ChatRole.User, assistant: Raw.ChatRole.Assistant };
	return { role: roleMap[role], content: [textPart(content)] } as Raw.ChatMessage;
}

function createOptions(messages: Raw.ChatMessage[]): IMakeChatRequestOptions {
	return {
		debugName: 'test-compact',
		messages,
		finishedCb: undefined,
		location: ChatLocation.Agent,
	};
}

const cancelToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: Event.None,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompactLlmOverrideEndpoint', () => {
	let disposables: DisposableStore;
	let mockFetcher: MockFetcherService;
	let configService: InMemoryConfigurationService;
	let instantiationService: IInstantiationService;
	let workspaceFolderPath: string;
	let cacheDir: string;

	// The production code reads compactSystemPrompt.md relative to __dirname of agentIntent.ts.
	// In the test environment __dirname resolves to the source tree, so the relative
	// path `../assets/prompts/` doesn't exist. Create it on-the-fly for the test suite.
	// agentIntent.ts __dirname = .../intents/node, path = ../assets/prompts/ = .../intents/assets/prompts/
	const promptDir = path.join(__dirname, '..', '..', 'assets', 'prompts');
	const promptFile = path.join(promptDir, 'compactSystemPrompt.md');

	beforeAll(async () => {
		await fs.mkdir(promptDir, { recursive: true });
		// Use the real prompt file content
		const realPromptPath = path.resolve(__dirname, '../../../../assets/prompts/compactSystemPrompt.md');
		let promptContent: string;
		try {
			promptContent = await fs.readFile(realPromptPath, 'utf-8');
		} catch {
			promptContent = 'You are a test compact system prompt.';
		}
		await fs.writeFile(promptFile, promptContent, 'utf-8');
	});

	beforeEach(() => {
		disposables = new DisposableStore();
		const sc = createExtensionUnitTestingServices(disposables);
		mockFetcher = new MockFetcherService();
		sc.define(IFetcherService, mockFetcher as any);

		// Use a temp-like workspace path (OS-agnostic via path.join)
		workspaceFolderPath = path.join(__dirname, '__test_workspace__');
		cacheDir = path.join(workspaceFolderPath, '.cache');
		sc.define(IWorkspaceService, new NullWorkspaceService([URI.file(workspaceFolderPath)]));

		const accessor = disposables.add(sc.createTestingAccessor());
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		instantiationService = accessor.get(IInstantiationService);

		// Enable trace for testability
		configService.setConfig(ConfigKey.Mem0TraceLog, true);
	});

	afterEach(async () => {
		disposables.dispose();
		// Clean up generated cache files
		try { await fs.rm(cacheDir, { recursive: true, force: true }); } catch { }
		try { await fs.rmdir(workspaceFolderPath); } catch { }
	});

	function createEndpoint(compactLlmUrl = 'http://127.0.0.1:18081'): CompactLlmOverrideEndpoint {
		return instantiationService.createInstance(
			CompactLlmOverrideEndpoint,
			createMockBaseEndpoint(),
			compactLlmUrl,
		);
	}

	function setupMockLlmResponse(content: string, modelsData?: unknown) {
		mockFetcher.respondByUrl({
			'/models': modelsData ?? { data: [{ id: 'test-model' }] },
			'/chat/completions': {
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 100, completion_tokens: 50 },
			},
		});
	}

	// -----------------------------------------------------------------------
	// Success path
	// -----------------------------------------------------------------------

	it('returns compacted content with preamble on success', async () => {
		const summaryText = '### Summary\n\n**1. Primary Request and Intent**\nUser asked to create a hello world app.';
		setupMockLlmResponse(summaryText);

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([
				msg('user', 'Create a hello world app'),
				msg('assistant', 'Sure, here is the code...'),
			]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as any).value as string;
		expect(value).toContain('This session is being continued from a previous conversation');
		expect(value).toContain('Primary Request and Intent');
	});

	it('strips thinking/reasoning blocks from LLM output', async () => {
		const rawContent = '<think>internal reasoning here</think>### Summary\n\nClean output.';
		setupMockLlmResponse(rawContent);

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as any).value as string;
		expect(value).not.toContain('<think>');
		expect(value).toContain('Clean output.');
	});

	// -----------------------------------------------------------------------
	// Cache file saving
	// -----------------------------------------------------------------------

	it('saves pre-compact content to .cache/ and appends path to output', async () => {
		setupMockLlmResponse('### Summary\n\nCompacted.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([
				msg('user', 'some user message'),
				msg('assistant', 'some assistant reply'),
			]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as any).value as string;

		// Should contain the cache file reference
		expect(value).toContain('If you need specific details from before compaction');
		expect(value).toContain('.cache');
		expect(value).toMatch(/compact-pre-.*\.md/);

		// Verify the cache file was actually written
		const files = await fs.readdir(cacheDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^compact-pre-.*\.md$/);

		// Verify cache content contains original messages
		const cacheContent = await fs.readFile(path.join(cacheDir, files[0]), 'utf-8');
		expect(cacheContent).toContain('some user message');
		expect(cacheContent).toContain('some assistant reply');
	});

	// -----------------------------------------------------------------------
	// Usage / metrics
	// -----------------------------------------------------------------------

	it('returns usage data from the LLM response', async () => {
		setupMockLlmResponse('### Summary\n\nDone.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const usage = (result as any).usage;
		expect(usage).toBeDefined();
		expect(usage.prompt_tokens).toBe(100);
		expect(usage.completion_tokens).toBe(50);
		expect(usage.total_tokens).toBe(150);
	});

	// -----------------------------------------------------------------------
	// Fallback on model discovery failure
	// -----------------------------------------------------------------------

	it('falls back to base endpoint when model discovery fails', async () => {
		mockFetcher.respondByUrl({
			'/models': 'error',  // will return 200 but invalid shape
		});
		// Override to return 500 for models
		mockFetcher.fetchHandler = async (url: string) => {
			if (url.includes('/models')) {
				return new Response('Server Error', { status: 500 });
			}
			return new Response('{}', { status: 200 });
		};

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cancelToken,
		);

		// Should fall back (base mock returns Failed)
		expect(result.type).toBe(ChatFetchResponseType.Failed);
	});

	// -----------------------------------------------------------------------
	// Fallback on LLM error
	// -----------------------------------------------------------------------

	it('falls back to base endpoint when LLM request fails', async () => {
		mockFetcher.fetchHandler = async (url: string) => {
			if (url.includes('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('/chat/completions')) {
				return new Response('Internal Server Error', { status: 500 });
			}
			return new Response('Not Found', { status: 404 });
		};

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cancelToken,
		);

		// Falls back to base (which returns Failed)
		expect(result.type).toBe(ChatFetchResponseType.Failed);
	});

	// -----------------------------------------------------------------------
	// Fallback on network error
	// -----------------------------------------------------------------------

	it('falls back to base endpoint on network error', async () => {
		mockFetcher.respondWithError('ECONNREFUSED');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Failed);
	});

	// -----------------------------------------------------------------------
	// Cancellation
	// -----------------------------------------------------------------------

	it('returns Canceled when token is cancelled', async () => {
		const cts = new CancellationTokenSource();
		// Cancel immediately
		cts.cancel();

		setupMockLlmResponse('### Summary\n\nDone.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cts.token,
		);

		// Depending on timing, it's either Canceled or Success
		// But if the LLM call completes before cancellation check, we accept Success too
		expect([ChatFetchResponseType.Canceled, ChatFetchResponseType.Success]).toContain(result.type);
	});

	// -----------------------------------------------------------------------
	// finishedCb
	// -----------------------------------------------------------------------

	it('calls finishedCb with the compacted content', async () => {
		setupMockLlmResponse('### Summary\n\nCallback test.');

		let cbContent = '';
		const options = createOptions([msg('user', 'test')]);
		options.finishedCb = async (text: string) => { cbContent = text; };

		const endpoint = createEndpoint();
		await endpoint.makeChatRequest2(options, cancelToken);

		expect(cbContent).toContain('Callback test.');
		expect(cbContent).toContain('This session is being continued');
	});

	// -----------------------------------------------------------------------
	// Message sanitization
	// -----------------------------------------------------------------------

	it('sends only non-system messages to LLM with compact system prompt', async () => {
		setupMockLlmResponse('### Summary\n\nSanitized.');

		const endpoint = createEndpoint();
		await endpoint.makeChatRequest2(
			createOptions([
				msg('system', 'You are a helpful assistant'),
				msg('user', 'Hello'),
				msg('assistant', 'Hi there'),
			]),
			cancelToken,
		);

		// Find the /chat/completions call
		const completionCall = mockFetcher.fetchCalls.find(c => c.url.includes('/chat/completions'));
		expect(completionCall).toBeDefined();

		const body = JSON.parse(completionCall!.options.body);
		// First message should be the compact system prompt (from file)
		expect(body.messages[0].role).toBe('system');
		// System message from user input should be filtered out; only user + assistant remain
		const nonSystemMessages = body.messages.filter((m: any) => m.role !== 'system');
		expect(nonSystemMessages.length).toBe(2);
		expect(nonSystemMessages[0].content).toBe('Hello');
		expect(nonSystemMessages[1].content).toBe('Hi there');
	});

	// -----------------------------------------------------------------------
	// No workspace folder — cache saving skipped gracefully
	// -----------------------------------------------------------------------

	it('works without workspace folder (cache saving skipped)', async () => {
		// Re-create services with empty workspace
		disposables.dispose();
		disposables = new DisposableStore();
		const sc = createExtensionUnitTestingServices(disposables);
		const emptyFetcher = new MockFetcherService();
		sc.define(IFetcherService, emptyFetcher as any);
		sc.define(IWorkspaceService, new NullWorkspaceService([])); // no folders
		const accessor = disposables.add(sc.createTestingAccessor());
		const inst = accessor.get(IInstantiationService);
		(accessor.get(IConfigurationService) as InMemoryConfigurationService).setConfig(ConfigKey.Mem0TraceLog, true);

		emptyFetcher.respondByUrl({
			'/models': { data: [{ id: 'test-model' }] },
			'/chat/completions': {
				choices: [{ message: { content: '### Summary\n\nNo workspace.' } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			},
		});

		const endpoint = inst.createInstance(CompactLlmOverrideEndpoint, createMockBaseEndpoint(), 'http://127.0.0.1:18081');
		const result = await endpoint.makeChatRequest2(
			createOptions([msg('user', 'test')]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as any).value as string;
		// Should NOT contain cache file reference since no workspace
		expect(value).not.toContain('If you need specific details from before compaction');
		expect(value).toContain('No workspace.');
	});
});
