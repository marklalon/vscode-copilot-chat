/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, TokenLimit } from '@vscode/prompt-tsx';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { Tag } from '../../prompts/node/base/tag';
import { IMem0Service, Mem0Memory } from '../common/mem0Types';

const MAX_MEM0_CONTEXT_TOKENS = 1500;

export interface Mem0ContextPromptProps extends BasePromptElementProps {
	readonly query: string;
}

/**
 * Prompt component that performs a semantic search against the local mem0 service
 * and renders matching long-term memories into the prompt context.
 * Rendered on every turn (unlike MemoryContextPrompt which is first-turn only)
 * because each query may retrieve different relevant memories.
 */
export class Mem0ContextPrompt extends PromptElement<Mem0ContextPromptProps> {
	constructor(
		props: any,
		@IMem0Service private readonly mem0Service: IMem0Service,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(props);
	}

	async render(_state: void, _sizing: PromptSizing) {
		const enabled = this.configurationService.getConfig(ConfigKey.Mem0Enabled) ?? false;
		if (!enabled || !this.props.query) {
			return null;
		}

		const memories = await this.mem0Service.search(this.props.query);
		if (memories.length === 0) {
			return null;
		}

		this.logService.trace(`[Mem0] Recalled ${memories.length} memories for query`);

		const content = this.formatMemories(memories);

		return (
			<TokenLimit max={MAX_MEM0_CONTEXT_TOKENS}>
				<Tag name='mem0_memories'>
					The following are long-term memories recalled from mem0 based on semantic relevance to the current query. Use these to inform your response when applicable, but verify if uncertain.<br />
					<br />
					{content}
				</Tag>
			</TokenLimit>
		);
	}

	private formatMemories(memories: readonly Mem0Memory[]): string {
		return memories.map((m, i) => {
			const score = m.score !== undefined ? ` (relevance: ${m.score.toFixed(2)})` : '';
			return `${i + 1}. ${m.memory}${score}`;
		}).join('\n');
	}
}
