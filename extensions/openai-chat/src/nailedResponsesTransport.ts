/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderConfig } from './providerConfig';

interface ResponsesInputTextPart {
	type: 'input_text' | 'output_text';
	text: string;
}

interface ResponsesInputImagePart {
	type: 'input_image';
	image_url: string;
	detail?: 'auto';
}

interface ResponsesInputMessage {
	role: 'system' | 'user' | 'assistant';
	content: Array<ResponsesInputTextPart | ResponsesInputImagePart>;
}

interface ResponsesFunctionCallInput {
	type: 'function_call';
	call_id: string;
	name: string;
	arguments: string;
}

interface ResponsesFunctionCallOutputInput {
	type: 'function_call_output';
	call_id: string;
	output: string;
}

type ResponsesInputItem = ResponsesInputMessage | ResponsesFunctionCallInput | ResponsesFunctionCallOutputInput;

interface ResponsesFunctionTool {
	type: 'function';
	name: string;
	description: string;
	parameters: object;
}

interface ResponsesStreamEvent {
	type?: string;
	delta?: string;
	error?: {
		message?: string;
	};
}

interface ResponsesOutputContentPart {
	type?: string;
	text?: string;
}

interface ResponsesOutputItem {
	type?: string;
	content?: ResponsesOutputContentPart[];
	call_id?: string;
	name?: string;
	arguments?: string;
}

interface ResponsesResult {
	output?: ResponsesOutputItem[];
}

export class NailedResponsesTransport {

	constructor(private readonly getConfig: () => Promise<ProviderConfig>) { }

	async provideChatResponse(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (shouldUseStructuredResponse(messages, options)) {
			await this.fetchStructuredResponse(messages, options, progress, token);
			return;
		}

		await this.streamTextResponse(messages, progress, token);
	}

	private async streamTextResponse(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const config = await this.getConfig();
		const controller = new AbortController();
		const cancellationListener = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await fetch(`${config.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json',
					'Accept': 'text/event-stream',
				},
				body: JSON.stringify({
					model: config.model,
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
					this.handleEventBlock(eventBlock, progress);
					boundary = buffer.indexOf('\n\n');
				}
			}

			const tail = buffer.trim();
			if (tail) {
				this.handleEventBlock(tail, progress);
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

	private async fetchStructuredResponse(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const config = await this.getConfig();
		const controller = new AbortController();
		const cancellationListener = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await fetch(`${config.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: config.model,
					input: toResponsesInput(messages),
					tools: options.tools?.length ? options.tools.map(toResponsesTool) : undefined,
					tool_choice: options.tools?.length ? toResponsesToolChoice(options.toolMode) : undefined,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await toLanguageModelError(response);
			}

			const result = await response.json() as ResponsesResult;
			for (const output of result.output ?? []) {
				if (output.type === 'message') {
					for (const content of output.content ?? []) {
						if (content.type === 'output_text' && content.text) {
							progress.report(new vscode.LanguageModelTextPart(content.text));
						}
					}
					continue;
				}

				if (output.type === 'function_call' && output.name && output.call_id) {
					progress.report(new vscode.LanguageModelToolCallPart(
						output.call_id,
						output.name,
						parseToolArguments(output.arguments),
					));
				}
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

	private handleEventBlock(eventBlock: string, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
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
			progress.report(new vscode.LanguageModelTextPart(eventData.delta));
			return;
		}
		if (eventType === 'error') {
			throw new Error(eventData.error?.message || 'The provider returned an error event.');
		}
	}
}

function shouldUseStructuredResponse(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
): boolean {
	return Boolean(options.tools?.length || messages.some(message => message.content.some(part =>
		part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelToolResultPart,
	)));
}

function toResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesInputItem[] {
	const input: ResponsesInputItem[] = [];

	for (const message of messages) {
		const messageContent = toResponsesMessageContent(message.role, message.content);
		if (messageContent.length) {
			input.push({
				role: toResponsesRole(message.role),
				content: messageContent,
			});
		}

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				input.push({
					type: 'function_call',
					call_id: part.callId,
					name: part.name,
					arguments: JSON.stringify(part.input ?? {}),
				});
				continue;
			}

			if (part instanceof vscode.LanguageModelToolResultPart) {
				input.push({
					type: 'function_call_output',
					call_id: part.callId,
					output: serializeToolResultContent(part.content),
				});
			}
		}
	}

	return input;
}

function toResponsesRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
	if (role === vscode.LanguageModelChatMessageRole.Assistant) {
		return 'assistant';
	}

	if (role === vscode.LanguageModelChatMessageRole.System) {
		return 'system';
	}

	return 'user';
}

function toResponsesMessageContent(
	role: vscode.LanguageModelChatMessageRole,
	content: readonly (vscode.LanguageModelInputPart | unknown)[],
): Array<ResponsesInputTextPart | ResponsesInputImagePart> {
	const parts: Array<ResponsesInputTextPart | ResponsesInputImagePart> = [];
	const textType: ResponsesInputTextPart['type'] = role === vscode.LanguageModelChatMessageRole.Assistant ? 'output_text' : 'input_text';
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			if (part.value.trim()) {
				parts.push({ type: textType, text: part.value });
			}
			continue;
		}

		if (part instanceof vscode.LanguageModelDataPart) {
			const imagePart = dataPartToInputImage(part);
			if (imagePart) {
				parts.push(imagePart);
				continue;
			}

			const text = dataPartToText(part);
			if (text.trim()) {
				parts.push({ type: textType, text });
			}
		}
	}

	return parts;
}

function toResponsesTool(tool: vscode.LanguageModelChatTool): ResponsesFunctionTool {
	return {
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema ?? { type: 'object', properties: {} },
	};
}

function toResponsesToolChoice(toolMode: vscode.LanguageModelChatToolMode): 'auto' | 'required' {
	return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

function parseToolArguments(rawArguments: string | undefined): object {
	if (!rawArguments) {
		return {};
	}

	try {
		return JSON.parse(rawArguments) as object;
	} catch {
		return { raw: rawArguments };
	}
}

function serializeToolResultContent(content: readonly unknown[]): string {
	const serialized = content
		.map(part => serializeToolResultPart(part))
		.filter(value => !!value);

	return serialized.join('\n\n') || 'Tool completed with no textual output.';
}

function serializeToolResultPart(part: unknown): string {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}

	if (part instanceof vscode.LanguageModelDataPart) {
		return dataPartToText(part);
	}

	try {
		return JSON.stringify(part);
	} catch {
		return String(part);
	}
}

function dataPartToInputImage(part: vscode.LanguageModelDataPart): ResponsesInputImagePart | undefined {
	if (!isImageMimeType(part.mimeType)) {
		return undefined;
	}

	return {
		type: 'input_image',
		image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`,
		detail: 'auto',
	};
}

function dataPartToText(part: vscode.LanguageModelDataPart): string {
	const mimeType = part.mimeType.toLowerCase();
	if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml')) {
		return new TextDecoder().decode(part.data);
	}

	if (isImageMimeType(mimeType)) {
		return `[${part.mimeType} image attachment]`;
	}

	return `[${part.mimeType} data omitted]`;
}

function isImageMimeType(mimeType: string): boolean {
	return mimeType.toLowerCase().startsWith('image/');
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
