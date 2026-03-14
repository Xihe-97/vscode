/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createNailedChatParticipant } from './nailedChatParticipant';
import { NailedLanguageModelChatProvider } from './nailedLanguageModelProvider';
import { loadProviderConfig, NAILED_VENDOR } from './providerConfig';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	let configPromise: Promise<Awaited<ReturnType<typeof loadProviderConfig>>> | undefined;
	const getConfig = () => {
		configPromise ??= loadProviderConfig();
		return configPromise;
	};

	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(NAILED_VENDOR, new NailedLanguageModelChatProvider(getConfig)));
	context.subscriptions.push(createNailedChatParticipant(getConfig));

	void getConfig().catch(error => {
		const message = error instanceof Error ? error.message : vscode.l10n.t('Failed to initialize the configured provider.');
		void vscode.window.showErrorMessage(vscode.l10n.t('OpenAI Chat initialization failed: {0}', message));
	});
}

export function deactivate(): void {
	// no-op
}
