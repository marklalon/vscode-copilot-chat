/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';

/**
 * A single memory entry returned by mem0.
 */
export interface Mem0Memory {
	readonly id: string;
	readonly memory: string;
	readonly hash?: string;
	readonly metadata?: Record<string, unknown>;
	readonly score?: number;
	readonly created_at?: string;
	readonly updated_at?: string;
}

/**
 * Result of a mem0 search operation.
 */
export interface Mem0SearchResult {
	readonly results: readonly Mem0Memory[];
}

/**
 * Result of a mem0 add operation.
 */
export interface Mem0AddResult {
	readonly results: readonly {
		readonly id: string;
		readonly memory: string;
		readonly event: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
	}[];
}

/**
 * Service for interacting with a local mem0 instance for long-term memory.
 * Wraps the mem0 REST API (search/add/getAll) with graceful fallback
 * when the service is unavailable.
 */
export interface IMem0Service {
	readonly _serviceBrand: undefined;

	/**
	 * Search memories relevant to the given query using semantic similarity.
	 * Returns an empty array if mem0 is unavailable or disabled.
	 */
	search(query: string, limit?: number): Promise<readonly Mem0Memory[]>;

	/**
	 * Add a conversation turn to mem0 for automatic memory extraction.
	 * Messages should be in OpenAI chat format [{role, content}].
	 */
	add(messages: readonly { role: string; content: string }[], metadata?: Record<string, unknown>): Promise<Mem0AddResult | undefined>;

	/**
	 * Get all memories for the current user.
	 */
	getAll(): Promise<readonly Mem0Memory[]>;

	/**
	 * Clear all memories for the current workspace-scoped user.
	 * Returns true when the request succeeds.
	 */
	clearWorkspaceMemories(): Promise<boolean>;
}

export const IMem0Service = createServiceIdentifier<IMem0Service>('IMem0Service');
