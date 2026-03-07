/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderConfig } from './providerConfig';
import { NailedResponsesTransport } from './nailedResponsesTransport';

export class NailedLanguageModelChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {

	private readonly transport: NailedResponsesTransport;

	constructor(private readonly config: ProviderConfig) {
		this.transport = new NailedResponsesTransport(config);
	}

	provideLanguageModelChatInformation(): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		return [{
			id: this.config.model,
			name: this.config.model,
			family: this.config.model,
			version: 'nailed',
			maxInputTokens: this.config.maxInputTokens,
			maxOutputTokens: this.config.maxInputTokens,
			isDefault: true,
			isUserSelectable: true,
			capabilities: {},
		}];
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (model.id !== this.config.model) {
			throw vscode.LanguageModelError.NotFound(`Unknown model: ${model.id}`);
		}
		await this.transport.streamText(messages, text => {
			progress.report(new vscode.LanguageModelTextPart(text));
		}, token);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const text = typeof value === 'string'
			? value
			: value.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join(' ');
		return Math.max(1, Math.ceil(text.length / 4));
	}
}
