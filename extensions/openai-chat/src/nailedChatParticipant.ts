/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderConfig } from './providerConfig';

const PARTICIPANT_ID = 'nailed.chat';

export function createNailedChatParticipant(config: ProviderConfig): vscode.ChatParticipant {
	return vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, context, stream, token) => {
		try {
			const model = request.model.vendor === config.vendor ? request.model : await resolveFallbackModel(config);
			if (!model) {
				return {
					errorDetails: {
						message: vscode.l10n.t('The configured chat model is unavailable.'),
					},
				};
			}

			const messages = buildMessages(request, context);
			const response = await model.sendRequest(messages, {
				justification: vscode.l10n.t('Send the current chat request to the configured provider.'),
			}, token);
			for await (const chunk of response.text) {
				stream.markdown(chunk);
			}
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : vscode.l10n.t('The provider request failed.');
			return {
				errorDetails: {
					message,
				},
			};
		}
	});
}

function buildMessages(request: vscode.ChatRequest, context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
			continue;
		}
		if (turn instanceof vscode.ChatResponseTurn) {
			const markdown = turn.response
				.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
				.filter(value => !!value)
				.join('\n\n')
				.trim();
			if (markdown) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(markdown));
			}
		}
	}
	messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
	return messages;
}

async function resolveFallbackModel(config: ProviderConfig): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels({ vendor: config.vendor, id: config.model });
	return models[0];
}
