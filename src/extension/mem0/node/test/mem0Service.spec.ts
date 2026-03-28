/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { isUUID } from '../../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { Mem0Memory } from '../../common/mem0Types';
import { Mem0Service, stripMem0Tags } from '../mem0Service';

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
	let mockFileSystemService: MockFileSystemService;
	let service: Mem0Service;
	let instantiationService: IInstantiationService;
	let workspaceFolder: URI;
	let mem0ConfigFile: URI;

	beforeEach(() => {
		disposables = new DisposableStore();
		const sc = createExtensionUnitTestingServices(disposables);
		mockFetcher = new MockFetcherService();
		sc.define(IFetcherService, mockFetcher as any);
		workspaceFolder = URI.file('/workspace/project-a');
		sc.define(IWorkspaceService, new NullWorkspaceService([workspaceFolder]));
		const accessor = disposables.add(sc.createTestingAccessor());
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		instantiationService = accessor.get(IInstantiationService);
		mockFileSystemService = accessor.get(IFileSystemService) as MockFileSystemService;
		mem0ConfigFile = URI.joinPath(workspaceFolder, '.vscode', 'mem0.json');
		mockFileSystemService.mockFile(mem0ConfigFile, JSON.stringify({ userId: 'test-user' }));

		// Default: mem0 enabled, endpoints pointing to test servers
		configService.setConfig(ConfigKey.Mem0Enabled, true);
		configService.setConfig(ConfigKey.Mem0Endpoint, 'http://127.0.0.1:18000');

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

	// ── userId resolution ────────────────────────────────────

	describe('userId resolution', () => {
		it('uses userId from project .vscode/mem0.json', async () => {
			mockFetcher.respondWith({ results: [] });
			await service.search('test');

			const body = JSON.parse(mockFetcher.fetchCalls[0].options.body);
			expect(body.user_id).toBe('test-user');
		});

		it('generates and persists project userId when .vscode/mem0.json is missing', async () => {
			await mockFileSystemService.delete(mem0ConfigFile);
			mockFetcher.respondWith({ results: [] });

			await service.search('test');

			const body = JSON.parse(mockFetcher.fetchCalls[0].options.body);
			expect(body.user_id.startsWith('workspace:')).toBe(true);
			expect(isUUID(body.user_id.slice('workspace:'.length))).toBe(true);

			const persistedRaw = await mockFileSystemService.readFile(mem0ConfigFile);
			const persisted = JSON.parse(new TextDecoder().decode(persistedRaw)) as { userId?: string };
			expect(persisted.userId).toBe(body.user_id);
		});
	});

	describe('stripMem0Tags', () => {
		it('should remove mem0_memories tags from text', () => {
			const input = 'Hello <mem0_memories>\n1. some memory (relevance: 0.92)\n</mem0_memories> world';
			expect(stripMem0Tags(input)).toBe('Hello  world');
		});

		it('should return text unchanged when no tags present', () => {
			expect(stripMem0Tags('no tags here')).toBe('no tags here');
		});

		it('should remove multiple tag blocks', () => {
			const input = '<mem0_memories>a</mem0_memories> middle <mem0_memories>b</mem0_memories>';
			expect(stripMem0Tags(input)).toBe('middle');
		});

		it('should handle empty string', () => {
			expect(stripMem0Tags('')).toBe('');
		});

		it('should handle multiline tag content', () => {
			const input = `Before
<mem0_memories>
The following are long-term memories recalled from mem0.
1. User prefers dark mode (relevance: 0.95)
2. Project uses TypeScript (relevance: 0.88)
</mem0_memories>
After`;
			expect(stripMem0Tags(input)).toBe('Before\n\nAfter');
		});
	});
});
