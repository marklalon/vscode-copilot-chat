/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { CompactLlmOverrideEndpoint } from '../mem0SmartCompactService';

class MockFetcherService {
	declare readonly _serviceBrand: undefined;

	readonly fetchCalls: { url: string; options: unknown }[] = [];
	fetchHandler: (url: string, options: unknown) => Promise<Response> = async () => new Response('{}', { status: 200 });

	readonly onDidFetch = { dispose: () => { } } as const;
	readonly onDidCompleteFetch = { dispose: () => { } } as const;

	getUserAgentLibrary() { return 'test'; }
	createWebSocket() { return {} as never; }
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

	async fetch(url: string, options: unknown): Promise<Response> {
		this.fetchCalls.push({ url, options });
		return this.fetchHandler(url, options);
	}

	respondByUrl(handlers: Record<string, unknown>) {
		this.fetchHandler = async url => {
			for (const [pattern, body] of Object.entries(handlers)) {
				if (url.includes(pattern)) {
					return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
			}
			return new Response('Not Found', { status: 404 });
		};
	}

	respondWithError(message = 'network error') {
		this.fetchHandler = async () => { throw new Error(message); };
	}
}

function createMockBaseEndpoint(): IChatEndpoint {
	return {
		urlOrRequestMetadata: 'http://base-endpoint',
		name: 'test-model',
		version: '1.0',
		family: 'test',
		tokenizer: 'cl100k_base' as never,
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
		acquireTokenizer: () => ({ tokenize: () => [], detokenize: () => '' }) as never,
		createRequestBody: () => ({}) as never,
		processResponseFromChatEndpoint: (() => { }) as never,
		makeChatRequest: async () => ({ type: ChatFetchResponseType.Failed, reason: 'not implemented', requestId: '', serverRequestId: undefined }),
		makeChatRequest2: async () => ({ type: ChatFetchResponseType.Failed, reason: 'not implemented', requestId: '', serverRequestId: undefined }),
		cloneWithTokenOverride: function () { return this; },
	} as IChatEndpoint;
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

describe('CompactLlmOverrideEndpoint', () => {
	let disposables: DisposableStore;
	let mockFetcher: MockFetcherService;
	let configService: InMemoryConfigurationService;
	let instantiationService: IInstantiationService;
	let workspaceFolderPath: string;
	let cacheDir: string;

	beforeEach(() => {
		disposables = new DisposableStore();
		const serviceCollection = createExtensionUnitTestingServices(disposables);
		mockFetcher = new MockFetcherService();
		serviceCollection.define(IFetcherService, mockFetcher as never);

		workspaceFolderPath = path.join(__dirname, '__test_workspace__');
		cacheDir = path.join(workspaceFolderPath, '.vscode', '.cache');
		serviceCollection.define(IWorkspaceService, new NullWorkspaceService([URI.file(workspaceFolderPath)]));

		const accessor = disposables.add(serviceCollection.createTestingAccessor());
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		instantiationService = accessor.get(IInstantiationService);
		configService.setConfig(ConfigKey.Mem0TraceLog, true);
	});

	afterEach(async () => {
		disposables.dispose();
		await fs.rm(workspaceFolderPath, { recursive: true, force: true });
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

	it('returns compacted content with preamble on success', async () => {
		setupMockLlmResponse('### Summary\n\n**1. Primary Request and Intent**\nUser asked to create a hello world app.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(
			createOptions([
				msg('user', 'Create a hello world app'),
				msg('assistant', 'Sure, here is the code...'),
			]),
			cancelToken,
		);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as { value: string }).value;
		expect(value).toContain('This session is being continued from a previous conversation');
		expect(value).toContain('Primary Request and Intent');
	});

	it('strips thinking and reasoning blocks from LLM output', async () => {
		setupMockLlmResponse('<think>internal reasoning here</think>### Summary\n\nClean output.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cancelToken);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as { value: string }).value;
		expect(value).not.toContain('<think>');
		expect(value).toContain('Clean output.');
	});

	it('saves pre-compact content to .vscode/.cache and appends the path to output', async () => {
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
		const value = (result as { value: string }).value;
		expect(value).toContain('If you need specific details from before compaction');
		expect(value).toContain('.vscode');
		expect(value).toMatch(/compact-pre-.*\.md/);

		const files = await fs.readdir(cacheDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^compact-pre-.*\.md$/);

		const cacheContent = await fs.readFile(path.join(cacheDir, files[0]), 'utf-8');
		expect(cacheContent).toContain('some user message');
		expect(cacheContent).toContain('some assistant reply');
	});

	it('keeps only the 10 newest pre-compact cache files', async () => {
		setupMockLlmResponse('### Summary\n\nCompacted.');
		await fs.mkdir(cacheDir, { recursive: true });

		for (let i = 0; i < 11; i++) {
			const fileName = `compact-pre-old-${i.toString().padStart(2, '0')}.md`;
			const filePath = path.join(cacheDir, fileName);
			await fs.writeFile(filePath, `old ${i}`, 'utf-8');
			const timestamp = new Date(Date.now() - ((11 - i) * 1000));
			await fs.utimes(filePath, timestamp, timestamp);
		}

		const endpoint = createEndpoint();
		await endpoint.makeChatRequest2(
			createOptions([
				msg('user', 'new user message'),
				msg('assistant', 'new assistant reply'),
			]),
			cancelToken,
		);

		const files = await fs.readdir(cacheDir);
		expect(files).toHaveLength(10);
		expect(files).not.toContain('compact-pre-old-00.md');
		expect(files).not.toContain('compact-pre-old-01.md');

		const fileContents = await Promise.all(files.map(async file => fs.readFile(path.join(cacheDir, file), 'utf-8')));
		expect(fileContents.some(content => content.includes('new user message'))).toBe(true);
	});

	it('returns usage data from the LLM response', async () => {
		setupMockLlmResponse('### Summary\n\nDone.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cancelToken);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const usage = (result as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }).usage;
		expect(usage).toBeDefined();
		expect(usage.prompt_tokens).toBe(100);
		expect(usage.completion_tokens).toBe(50);
		expect(usage.total_tokens).toBe(150);
	});

	it('falls back to the base endpoint when model discovery fails', async () => {
		mockFetcher.fetchHandler = async url => {
			if (url.includes('/models')) {
				return new Response('Server Error', { status: 500 });
			}
			return new Response('{}', { status: 200 });
		};

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cancelToken);

		expect(result.type).toBe(ChatFetchResponseType.Failed);
	});

	it('falls back to the base endpoint when the LLM request fails', async () => {
		mockFetcher.fetchHandler = async url => {
			if (url.includes('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('/chat/completions')) {
				return new Response('Internal Server Error', { status: 500 });
			}
			return new Response('Not Found', { status: 404 });
		};

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cancelToken);

		expect(result.type).toBe(ChatFetchResponseType.Failed);
	});

	it('falls back to the base endpoint on network error', async () => {
		mockFetcher.respondWithError('ECONNREFUSED');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cancelToken);

		expect(result.type).toBe(ChatFetchResponseType.Failed);
	});

	it('returns canceled when the token is canceled before the request completes', async () => {
		const cts = new CancellationTokenSource();
		cts.cancel();
		setupMockLlmResponse('### Summary\n\nDone.');

		const endpoint = createEndpoint();
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cts.token);

		expect([ChatFetchResponseType.Canceled, ChatFetchResponseType.Success]).toContain(result.type);
	});

	it('calls finishedCb with the compacted content', async () => {
		setupMockLlmResponse('### Summary\n\nCallback test.');

		let callbackContent = '';
		const options = createOptions([msg('user', 'test')]);
		options.finishedCb = async (text: string) => {
			callbackContent = text;
			return undefined;
		};

		const endpoint = createEndpoint();
		await endpoint.makeChatRequest2(options, cancelToken);

		expect(callbackContent).toContain('Callback test.');
		expect(callbackContent).toContain('This session is being continued');
	});

	it('sends only non-system messages to the local LLM after injecting the compact system prompt', async () => {
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

		const completionCall = mockFetcher.fetchCalls.find(call => call.url.includes('/chat/completions'));
		const body = JSON.parse((completionCall?.options as { body: string }).body);
		expect(body.messages[0].role).toBe('system');

		const nonSystemMessages = body.messages.filter((message: { role: string }) => message.role !== 'system');
		expect(nonSystemMessages.length).toBe(2);
		expect(nonSystemMessages[0].content).toBe('Hello');
		expect(nonSystemMessages[1].content).toBe('Hi there');
	});

	it('works without a workspace folder and skips cache saving', async () => {
		disposables.dispose();
		disposables = new DisposableStore();
		const serviceCollection = createExtensionUnitTestingServices(disposables);
		const emptyFetcher = new MockFetcherService();
		serviceCollection.define(IFetcherService, emptyFetcher as never);
		serviceCollection.define(IWorkspaceService, new NullWorkspaceService([]));

		const accessor = disposables.add(serviceCollection.createTestingAccessor());
		(accessor.get(IConfigurationService) as InMemoryConfigurationService).setConfig(ConfigKey.Mem0TraceLog, true);
		const instantiation = accessor.get(IInstantiationService);

		emptyFetcher.respondByUrl({
			'/models': { data: [{ id: 'test-model' }] },
			'/chat/completions': {
				choices: [{ message: { content: '### Summary\n\nNo workspace.' } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			},
		});

		const endpoint = instantiation.createInstance(CompactLlmOverrideEndpoint, createMockBaseEndpoint(), 'http://127.0.0.1:18081');
		const result = await endpoint.makeChatRequest2(createOptions([msg('user', 'test')]), cancelToken);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		const value = (result as { value: string }).value;
		expect(value).not.toContain('If you need specific details from before compaction');
		expect(value).toContain('No workspace.');
	});
});