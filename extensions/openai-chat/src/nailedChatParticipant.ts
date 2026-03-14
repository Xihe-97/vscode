/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderConfig } from './providerConfig';

const PARTICIPANT_ID = 'nailed.chat';
const MAX_REFERENCE_COUNT = 12;
const MAX_REFERENCE_CHARACTERS = 12000;
const LOCATION_CONTEXT_LINES = 20;
const DIRECTORY_PREVIEW_LIMIT = 40;
const MAX_TOOL_ITERATIONS = 5;
const REQUEST_JUSTIFICATION = vscode.l10n.t('Send the current chat request to the configured provider.');

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

			const messages = await buildMessages(request, context);
			const tools = getAttachedTools(request.toolReferences);
			return await runModelConversation(model, request, messages, tools, stream, token);
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

async function buildMessages(request: vscode.ChatRequest, context: vscode.ChatContext): Promise<vscode.LanguageModelChatMessage[]> {
	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(await buildPromptWithReferences(turn.prompt, turn.references, turn.toolReferences)));
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
	messages.push(vscode.LanguageModelChatMessage.User(await buildPromptWithReferences(request.prompt, request.references, request.toolReferences)));
	return messages;
}

async function resolveFallbackModel(config: ProviderConfig): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels({ vendor: config.vendor, id: config.model });
	return models[0];
}

async function runModelConversation(
	model: vscode.LanguageModelChat,
	request: vscode.ChatRequest,
	initialMessages: vscode.LanguageModelChatMessage[],
	tools: vscode.LanguageModelChatTool[],
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	let messages = initialMessages;
	let toolMode = getInitialToolMode(tools);

	for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
		const response = await model.sendRequest(messages, {
			justification: REQUEST_JUSTIFICATION,
			tools: tools.length ? tools : undefined,
			toolMode,
		}, token);

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart> = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];

		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				assistantParts.push(part);
				stream.markdown(part.value);
				continue;
			}

			if (part instanceof vscode.LanguageModelToolCallPart) {
				assistantParts.push(part);
				toolCalls.push(part);
				continue;
			}

			if (part instanceof vscode.LanguageModelDataPart) {
				assistantParts.push(part);
			}
		}

		if (!toolCalls.length) {
			return {};
		}

		const toolResultParts = await invokeTools(toolCalls, request, token);
		messages = [
			...messages,
			vscode.LanguageModelChatMessage.Assistant(assistantParts),
			vscode.LanguageModelChatMessage.User(toolResultParts),
		];
		toolMode = vscode.LanguageModelChatToolMode.Auto;
	}

	return {
		errorDetails: {
			message: vscode.l10n.t('The provider exceeded the maximum supported tool-call depth.'),
		},
	};
}

async function invokeTools(
	toolCalls: readonly vscode.LanguageModelToolCallPart[],
	request: vscode.ChatRequest,
	token: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResultPart[]> {
	const resultParts: vscode.LanguageModelToolResultPart[] = [];

	for (const toolCall of toolCalls) {
		try {
			const result = await vscode.lm.invokeTool(toolCall.name, {
				toolInvocationToken: request.toolInvocationToken,
				input: toolCall.input,
			}, token);
			resultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, result.content));
		} catch (error) {
			const message = error instanceof Error ? error.message : vscode.l10n.t('Tool invocation failed.');
			resultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
				new vscode.LanguageModelTextPart(`Tool ${toolCall.name} failed: ${message}`),
			]));
		}
	}

	return resultParts;
}

function getAttachedTools(toolReferences: readonly vscode.ChatLanguageModelToolReference[]): vscode.LanguageModelChatTool[] {
	if (!toolReferences.length) {
		return [];
	}

	const attachedNames = new Set(toolReferences.map(reference => reference.name));
	return vscode.lm.tools
		.filter(tool => attachedNames.has(tool.name))
		.map(tool => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
}

function getInitialToolMode(tools: readonly vscode.LanguageModelChatTool[]): vscode.LanguageModelChatToolMode | undefined {
	if (!tools.length) {
		return undefined;
	}

	return tools.length === 1 ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto;
}

async function buildPromptWithReferences(
	prompt: string,
	references: readonly vscode.ChatPromptReference[],
	toolReferences: readonly vscode.ChatLanguageModelToolReference[],
): Promise<string> {
	const sections: string[] = [];
	const trimmedPrompt = prompt.trim();
	if (trimmedPrompt) {
		sections.push(trimmedPrompt);
	}

	if (toolReferences.length) {
		sections.push([
			'Attached tools:',
			...toolReferences.map(reference => `- ${reference.name}`),
		].join('\n'));
	}

	if (references.length) {
		const renderedReferences = await Promise.all(references.slice(0, MAX_REFERENCE_COUNT).map(renderReference));
		const visibleReferences = renderedReferences.filter((value): value is string => !!value);
		if (visibleReferences.length) {
			sections.push(['Attached context from VS Code:', ...visibleReferences].join('\n\n'));
		}
		if (references.length > MAX_REFERENCE_COUNT) {
			sections.push(vscode.l10n.t('Additional attached context omitted: {0} more reference(s).', references.length - MAX_REFERENCE_COUNT));
		}
	}

	return sections.join('\n\n');
}

async function renderReference(reference: vscode.ChatPromptReference): Promise<string | undefined> {
	const lines = [`Reference: ${reference.name}`];
	if (reference.modelDescription) {
		lines.push(`Description: ${reference.modelDescription}`);
	}

	try {
		const renderedValue = await renderReferenceValue(reference.value);
		if (renderedValue) {
			lines.push(renderedValue);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : vscode.l10n.t('Unable to resolve reference content.');
		lines.push(`Note: ${message}`);
	}

	return lines.join('\n');
}

async function renderReferenceValue(value: unknown): Promise<string | undefined> {
	if (typeof value === 'string') {
		return formatContentBlock('Content', value);
	}

	if (value instanceof vscode.Location) {
		const document = await vscode.workspace.openTextDocument(value.uri);
		const snippet = extractLocationSnippet(document, value.range);
		return [
			`Location: ${value.uri.toString()}#${formatRange(value.range)}`,
			formatContentBlock('Content', snippet, document.languageId),
		].join('\n');
	}

	if (isUri(value)) {
		const stat = await vscode.workspace.fs.stat(value);
		if (stat.type & vscode.FileType.Directory) {
			return await renderDirectoryReference(value);
		}

		const document = await vscode.workspace.openTextDocument(value);
		return [
			`File: ${value.toString()}`,
			formatContentBlock('Content', document.getText(), document.languageId),
		].join('\n');
	}

	return undefined;
}

async function renderDirectoryReference(uri: vscode.Uri): Promise<string> {
	const entries = await vscode.workspace.fs.readDirectory(uri);
	const preview = entries
		.slice(0, DIRECTORY_PREVIEW_LIMIT)
		.map(([name, type]) => `- ${type === vscode.FileType.Directory ? `${name}/` : name}`);
	if (entries.length > DIRECTORY_PREVIEW_LIMIT) {
		preview.push(`- ... ${entries.length - DIRECTORY_PREVIEW_LIMIT} more entries`);
	}

	return [
		`Directory: ${uri.toString()}`,
		preview.length ? preview.join('\n') : 'Contents unavailable.',
	].join('\n');
}

function extractLocationSnippet(document: vscode.TextDocument, range: vscode.Range): string {
	const startLine = Math.max(0, range.start.line - LOCATION_CONTEXT_LINES);
	const endLine = Math.min(document.lineCount - 1, range.end.line + LOCATION_CONTEXT_LINES);
	const endCharacter = document.lineAt(endLine).text.length;
	return document.getText(new vscode.Range(startLine, 0, endLine, endCharacter));
}

function formatRange(range: vscode.Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

function formatContentBlock(label: string, content: string, languageId?: string): string {
	const trimmed = truncateContent(content.trim());
	if (!trimmed) {
		return `${label}: (empty)`;
	}

	const languageLabel = languageId && languageId !== 'plaintext' ? ` (${languageId})` : '';
	return `${label}${languageLabel}:\n<<<context\n${trimmed}\n>>>`;
}

function truncateContent(content: string): string {
	if (content.length <= MAX_REFERENCE_CHARACTERS) {
		return content;
	}

	return `${content.slice(0, MAX_REFERENCE_CHARACTERS)}\n[Truncated after ${MAX_REFERENCE_CHARACTERS} characters]`;
}

function isUri(value: unknown): value is vscode.Uri {
	return value instanceof vscode.Uri;
}
