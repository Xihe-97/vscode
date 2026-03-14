/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderConfig } from './providerConfig';
import { NailedResponsesTransport } from './nailedResponsesTransport';

export class NailedLanguageModelChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {

	private readonly transport: NailedResponsesTransport;

	constructor(private readonly getConfig: () => Promise<ProviderConfig>) {
		this.transport = new NailedResponsesTransport(getConfig);
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const config = await this.getConfig();
		return [{
			id: config.model,
			name: config.model,
			family: config.model,
			version: 'nailed',
			maxInputTokens: config.maxInputTokens,
			maxOutputTokens: config.maxInputTokens,
			isDefault: true,
			isUserSelectable: true,
			capabilities: { toolCalling: true, imageInput: true },
		}];
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const config = await this.getConfig();
		if (model.id !== config.model) {
			throw vscode.LanguageModelError.NotFound(`Unknown model: ${model.id}`);
		}
		await this.transport.provideChatResponse(messages, options, progress, token);
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
