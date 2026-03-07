/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderConfig } from './providerConfig';

interface ResponsesInputTextPart {
	type: 'input_text';
	text: string;
}

interface ResponsesMessage {
	role: 'user' | 'assistant';
	content: ResponsesInputTextPart[];
}

interface ResponsesStreamEvent {
	type?: string;
	delta?: string;
	error?: {
		message?: string;
	};
}

export class NailedResponsesTransport {

	constructor(private readonly config: ProviderConfig) { }

	async streamText(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		onText: (text: string) => void,
		token: vscode.CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		const cancellationListener = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await fetch(`${this.config.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.config.apiKey}`,
					'Content-Type': 'application/json',
					'Accept': 'text/event-stream',
				},
				body: JSON.stringify({
					model: this.config.model,
					input: toResponsesInput(messages),
					stream: true,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await toLanguageModelError(response);
			}
			if (!response.body) {
				throw new Error('The provider returned an empty response body.');
			}

			const decoder = new TextDecoder();
			let buffer = '';
			for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				buffer = buffer.replace(/\r\n/g, '\n');
				let boundary = buffer.indexOf('\n\n');
				while (boundary >= 0) {
					const eventBlock = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					this.handleEventBlock(eventBlock, onText);
					boundary = buffer.indexOf('\n\n');
				}
			}

			const tail = buffer.trim();
			if (tail) {
				this.handleEventBlock(tail, onText);
			}
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			throw error;
		} finally {
			cancellationListener.dispose();
		}
	}

	private handleEventBlock(eventBlock: string, onText: (text: string) => void): void {
		const lines = eventBlock.split('\n');
		let eventName = '';
		const dataLines: string[] = [];
		for (const line of lines) {
			if (line.startsWith('event:')) {
				eventName = line.slice('event:'.length).trim();
			} else if (line.startsWith('data:')) {
				dataLines.push(line.slice('data:'.length).trim());
			}
		}

		if (!dataLines.length) {
			return;
		}
		const dataText = dataLines.join('\n');
		if (dataText === '[DONE]') {
			return;
		}
		const eventData = JSON.parse(dataText) as ResponsesStreamEvent;
		const eventType = eventData.type ?? eventName;
		if (eventType === 'response.output_text.delta' && eventData.delta) {
			onText(eventData.delta);
			return;
		}
		if (eventType === 'error') {
			throw new Error(eventData.error?.message || 'The provider returned an error event.');
		}
	}
}

function toResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesMessage[] {
	return messages
		.map(message => ({
			role: toResponsesRole(message.role),
			content: toResponsesContent(message.content),
		}))
		.filter(message => message.content.length > 0);
}

function toResponsesRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
	return role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
}

function toResponsesContent(content: readonly (vscode.LanguageModelInputPart | unknown)[]): ResponsesInputTextPart[] {
	const text = content
		.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '')
		.filter(value => !!value)
		.join('\n\n')
		.trim();
	return text ? [{ type: 'input_text', text }] : [];
}

async function toLanguageModelError(response: Response): Promise<Error> {
	let message = `Request failed with status ${response.status}.`;
	try {
		const body = await response.text();
		if (body) {
			message = body;
		}
	} catch {
		// ignore body parse failures
	}
	if (response.status === 401 || response.status === 403) {
		return vscode.LanguageModelError.NoPermissions(message);
	}
	if (response.status === 404) {
		return vscode.LanguageModelError.NotFound(message);
	}
	if (response.status === 429) {
		return vscode.LanguageModelError.Blocked(message);
	}
	return new Error(message);
}
