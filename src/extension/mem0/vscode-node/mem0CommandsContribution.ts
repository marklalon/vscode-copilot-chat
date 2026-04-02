/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IMem0Service } from '../common/mem0Types';

const clearWorkspaceMemoryCommandId = 'github.copilot.chat.mem0.clearWorkspaceMemory';
const clearWorkspaceMemoryActionLabel = 'clear workspace memory';

export class Mem0CommandsContribution extends Disposable {
	constructor(
		@IMem0Service private readonly mem0Service: IMem0Service,
	) {
		super();

		this._register(vscode.commands.registerCommand(clearWorkspaceMemoryCommandId, async () => {
			const confirm = await vscode.window.showWarningMessage(
				l10n.t('Clear mem0 workspace memory? This cannot be undone.'),
				{ modal: true },
				l10n.t(clearWorkspaceMemoryActionLabel),
			);

			if (confirm !== l10n.t(clearWorkspaceMemoryActionLabel)) {
				return;
			}

			const cleared = await this.mem0Service.clearWorkspaceMemories();
			if (cleared) {
				vscode.window.showInformationMessage(l10n.t('Workspace mem0 memory cleared.'));
			} else {
				vscode.window.showErrorMessage(l10n.t('Failed to clear workspace mem0 memory.'));
			}
		}));
	}
}
