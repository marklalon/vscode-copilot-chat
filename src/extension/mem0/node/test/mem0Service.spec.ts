/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { Mem0Memory } from '../../common/mem0Types';
import { Mem0Service } from '../mem0Service';

/**
 * A mock IFetcherService that records calls and returns configurable responses.
 */
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

	/** Helper: set a JSON response for any fetch call */
	respondWith(json: unknown, status = 200) {
		this.fetchHandler = async () => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
	}

	/** Helper: set different responses per URL pattern */
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

	/** Helper: make fetch throw a network error */
	respondWithError(msg = 'network error') {
		this.fetchHandler = async () => { throw new Error(msg); };
	}
}

function makeMemory(overrides: Partial<Mem0Memory> & { memory: string }): Mem0Memory {
	const { memory, ...rest } = overrides;
	return {
		id: rest.id ?? 'mem-1',
		memory,
		score: rest.score ?? 0.9,
		created_at: rest.created_at ?? '2025-01-01T00:00:00Z',
		updated_at: rest.updated_at ?? '2025-01-01T00:00:00Z',
		...rest,
	};
}

describe('Mem0Service', () => {
	let disposables: DisposableStore;
	let configService: InMemoryConfigurationService;
	let mockFetcher: MockFetcherService;
	let service: Mem0Service;
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		disposables = new DisposableStore();
		const sc = createExtensionUnitTestingServices(disposables);
		mockFetcher = new MockFetcherService();
		sc.define(IFetcherService, mockFetcher as any);
		const accessor = disposables.add(sc.createTestingAccessor());
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		instantiationService = accessor.get(IInstantiationService);

		// Default: mem0 enabled, endpoints pointing to test servers
		configService.setConfig(ConfigKey.Mem0Enabled, true);
		configService.setConfig(ConfigKey.Mem0Endpoint, 'http://127.0.0.1:18000');
		configService.setConfig(ConfigKey.Mem0UserId, 'test-user');

		service = instantiationService.createInstance(Mem0Service);
		disposables.add(service);
	});

	afterEach(() => {
		disposables.dispose();
	});

	// ── search ──────────────────────────────────────────────

	describe('search', () => {
		it('returns empty when disabled', async () => {
			await configService.setConfig(ConfigKey.Mem0Enabled, false);
			const result = await service.search('hello');
			expect(result).toEqual([]);
			expect(mockFetcher.fetchCalls).toHaveLength(0);
		});

		it('calls /search with correct body', async () => {
			const mem = makeMemory({ memory: 'uses TypeScript', score: 0.8 });
			mockFetcher.respondWith({ results: [mem] });

			const result = await service.search('TypeScript preferences');
			expect(result).toHaveLength(1);
			expect(result[0].memory).toBe('uses TypeScript');

			const call = mockFetcher.fetchCalls[0];
			expect(call.url).toBe('http://127.0.0.1:18000/search');
			const body = JSON.parse(call.options.body);
			expect(body.query).toBe('TypeScript preferences');
			expect(body.user_id).toBe('test-user');
			expect(body.limit).toBe(10);
		});

		it('respects custom limit', async () => {
			mockFetcher.respondWith({ results: [] });
			await service.search('q', 5);
			const body = JSON.parse(mockFetcher.fetchCalls[0].options.body);
			expect(body.limit).toBe(5);
		});

		it('filters results below min relevance score', async () => {
			await configService.setConfig(ConfigKey.Mem0MinRelevanceScore, 0.7);
			mockFetcher.respondWith({
				results: [
					makeMemory({ id: 'high', memory: 'high score', score: 0.9 }),
					makeMemory({ id: 'low', memory: 'low score', score: 0.3 }),
					makeMemory({ id: 'edge', memory: 'edge score', score: 0.7 }),
				],
			});

			const result = await service.search('test');
			expect(result).toHaveLength(2);
			expect(result.map(m => m.id)).toEqual(['high', 'edge']);
		});

		it('uses default 0.5 threshold when not configured', async () => {
			mockFetcher.respondWith({
				results: [
					makeMemory({ memory: 'above', score: 0.6 }),
					makeMemory({ memory: 'below', score: 0.4 }),
				],
			});
			const result = await service.search('test');
			expect(result).toHaveLength(1);
			expect(result[0].memory).toBe('above');
		});

		it('returns empty array on HTTP error', async () => {
			mockFetcher.fetchHandler = async () => new Response('err', { status: 500 });
			const result = await service.search('test');
			expect(result).toEqual([]);
		});

		it('returns empty array on network error', async () => {
			mockFetcher.respondWithError('connection refused');
			const result = await service.search('test');
			expect(result).toEqual([]);
		});
	});

	// ── add ─────────────────────────────────────────────────

	describe('add', () => {
		it('returns undefined when disabled', async () => {
			await configService.setConfig(ConfigKey.Mem0Enabled, false);
			const result = await service.add([{ role: 'user', content: 'hi' }]);
			expect(result).toBeUndefined();
			expect(mockFetcher.fetchCalls).toHaveLength(0);
		});

		it('sends messages to /memories', async () => {
			const addResult = {
				results: [{ id: 'new-1', memory: 'user likes tabs', event: 'ADD' as const }],
			};
			mockFetcher.respondWith(addResult);

			const msgs = [
				{ role: 'user', content: 'I prefer tabs over spaces' },
				{ role: 'assistant', content: 'Noted!' },
			];
			const result = await service.add(msgs, { source: 'chat' });

			expect(result).toBeDefined();
			expect(result!.results[0].event).toBe('ADD');

			const body = JSON.parse(mockFetcher.fetchCalls[0].options.body);
			expect(body.messages).toEqual(msgs);
			expect(body.user_id).toBe('test-user');
			expect(body.metadata).toEqual({ source: 'chat' });
		});

		it('returns undefined on HTTP error', async () => {
			mockFetcher.fetchHandler = async () => new Response('err', { status: 500 });
			const result = await service.add([{ role: 'user', content: 'hello' }]);
			expect(result).toBeUndefined();
		});

		it('returns undefined on network error', async () => {
			mockFetcher.respondWithError();
			const result = await service.add([{ role: 'user', content: 'hello' }]);
			expect(result).toBeUndefined();
		});
	});

	// ── getAll ──────────────────────────────────────────────

	describe('getAll', () => {
		it('returns empty when disabled', async () => {
			await configService.setConfig(ConfigKey.Mem0Enabled, false);
			const result = await service.getAll();
			expect(result).toEqual([]);
		});

		it('calls GET /memories with user_id', async () => {
			const mems = [makeMemory({ memory: 'fact 1' }), makeMemory({ id: 'm2', memory: 'fact 2' })];
			mockFetcher.respondWith({ results: mems });

			const result = await service.getAll();
			expect(result).toHaveLength(2);

			const call = mockFetcher.fetchCalls[0];
			expect(call.url).toContain('/memories?user_id=test-user');
			expect(call.options.method).toBe('GET');
		});

		it('returns empty on failure', async () => {
			mockFetcher.respondWithError();
			const result = await service.getAll();
			expect(result).toEqual([]);
		});
	});

	// ── compressContext ─────────────────────────────────────

	describe('compressContext', () => {
		const sampleText = '1. User prefers TypeScript\n2. User prefers TypeScript strict mode\n3. Uses pnpm';

		beforeEach(() => {
			configService.setConfig(ConfigKey.Mem0CompressEnabled, true);
			configService.setConfig(ConfigKey.Mem0CompressLlmEndpoint, 'http://127.0.0.1:18081/v1');
			configService.setConfig(ConfigKey.Mem0CompressLlmModel, 'test-model');
		});

		it('returns original text when disabled', async () => {
			await configService.setConfig(ConfigKey.Mem0Enabled, false);
			const result = await service.compressContext(sampleText);
			expect(result).toBe(sampleText);
			expect(mockFetcher.fetchCalls).toHaveLength(0);
		});

		it('returns original text when compress disabled', async () => {
			await configService.setConfig(ConfigKey.Mem0CompressEnabled, false);
			const result = await service.compressContext(sampleText);
			expect(result).toBe(sampleText);
		});

		it('returns original text for empty input', async () => {
			const result = await service.compressContext('   ');
			expect(result).toBe('   ');
		});

		it('calls LLM chat completion endpoint', async () => {
			const compressed = '1. Prefers TypeScript strict mode\n2. Uses pnpm';
			mockFetcher.respondWith({
				choices: [{ message: { content: compressed } }],
			});

			const result = await service.compressContext(sampleText);
			expect(result).toBe(compressed);

			const call = mockFetcher.fetchCalls[0];
			expect(call.url).toBe('http://127.0.0.1:18081/v1/chat/completions');

			const body = JSON.parse(call.options.body);
			expect(body.model).toBe('test-model');
			expect(body.temperature).toBe(0);
			expect(body.messages).toHaveLength(2);
			expect(body.messages[0].role).toBe('system');
			expect(body.messages[1].role).toBe('user');
			expect(body.messages[1].content).toBe(sampleText);
		});

		it('returns original text on LLM HTTP error', async () => {
			mockFetcher.fetchHandler = async () => new Response('err', { status: 500 });
			const result = await service.compressContext(sampleText);
			expect(result).toBe(sampleText);
		});

		it('returns original text on LLM network error', async () => {
			mockFetcher.respondWithError('LLM unreachable');
			const result = await service.compressContext(sampleText);
			expect(result).toBe(sampleText);
		});

		it('returns original text when LLM returns empty content', async () => {
			mockFetcher.respondWith({ choices: [{ message: { content: '' } }] });
			const result = await service.compressContext(sampleText);
			expect(result).toBe(sampleText);
		});

		it('falls back to model discovery when model not configured', async () => {
			await configService.setConfig(ConfigKey.Mem0CompressLlmModel, '');

			mockFetcher.respondByUrl({
				'/models': { data: [{ id: 'discovered-model' }] },
				'/chat/completions': { choices: [{ message: { content: 'compressed' } }] },
			});

			const result = await service.compressContext(sampleText);
			expect(result).toBe('compressed');

			// Should have called /models first, then /chat/completions
			expect(mockFetcher.fetchCalls).toHaveLength(2);
			expect(mockFetcher.fetchCalls[0].url).toContain('/models');

			const body = JSON.parse(mockFetcher.fetchCalls[1].options.body);
			expect(body.model).toBe('discovered-model');
		});

		it('caches discovered model across calls', async () => {
			await configService.setConfig(ConfigKey.Mem0CompressLlmModel, '');

			mockFetcher.respondByUrl({
				'/models': { data: [{ id: 'cached-model' }] },
				'/chat/completions': { choices: [{ message: { content: 'compressed' } }] },
			});

			await service.compressContext(sampleText);
			await service.compressContext(sampleText);

			// /models should only be called once due to caching
			const modelCalls = mockFetcher.fetchCalls.filter(c => c.url.includes('/models'));
			expect(modelCalls).toHaveLength(1);
		});
	});

	// ── userId fallback ────────────────────────────────────

	describe('userId resolution', () => {
		it('falls back to machineId when no userId configured', async () => {
			await configService.setConfig(ConfigKey.Mem0UserId, '');
			mockFetcher.respondWith({ results: [] });

			await service.search('test');

			const body = JSON.parse(mockFetcher.fetchCalls[0].options.body);
			// Should use machineId or 'default' from NullEnvService
			expect(body.user_id).toBeDefined();
			expect(body.user_id).not.toBe('');
		});
	});
});
