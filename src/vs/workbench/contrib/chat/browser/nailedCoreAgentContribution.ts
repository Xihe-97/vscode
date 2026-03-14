/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { env } from '../../../../base/common/process.js';
import { joinPath } from '../../../../base/common/resources.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IChatProgress } from '../common/chatService/chatService.js';
import { IChatProgressHistoryResponseContent } from '../common/model/chatModel.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../common/constants.js';

const NAILED_AGENT_ID = 'nailed.chat.core';

interface NailedProviderConfig {
	readonly model: string;
	readonly baseUrl: string;
	readonly apiKey: string;
}

interface NailedResponsesInputMessage {
	role: 'user' | 'assistant';
	content: Array<{
		type: 'input_text' | 'output_text';
		text: string;
	}>;
}

interface NailedResponsesOutput {
	type?: string;
	content?: Array<{
		type?: string;
		text?: string;
	}>;
}

interface NailedResponsesResult {
	output?: NailedResponsesOutput[];
}

export class NailedCoreAgentContribution extends Disposable implements IWorkbenchContribution {

	public static readonly ID = 'workbench.contrib.chat.nailedCoreAgent';

	constructor(
		@IChatAgentService chatAgentService: IChatAgentService,
		@IFileService fileService: IFileService,		@ILogService logService: ILogService,
	) {
		super();

		this._register(chatAgentService.registerAgent(NAILED_AGENT_ID, {
			id: NAILED_AGENT_ID,
			name: 'nailed',
			fullName: 'Nailed',
			description: nls.localize('nailedAgentDescription', 'Chat with the configured Nailed provider.'),
			isDefault: true,
			isCore: true,
			modes: [ChatModeKind.Ask],
			slashCommands: [],
			disambiguation: [],
			locations: [ChatAgentLocation.Chat],
			metadata: {},
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher,
		}));

		this._register(chatAgentService.registerAgentImplementation(NAILED_AGENT_ID, new NailedCoreAgent(fileService, logService)));
	}
}

class NailedCoreAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		progress([{
			kind: 'progressMessage',
			content: new MarkdownString(nls.localize('nailedConnecting', 'Connecting to Nailed...')),
			shimmer: true,
		}]);

		try {
			const config = await this.readConfig();
			const input = toResponsesInput(request, history);
			const response = await this.fetchResponse(config, input, token);
			const text = getResponseText(response).trim();
			if (!text) {
				return {
					errorDetails: {
						message: nls.localize('nailedEmpty', 'The configured provider returned an empty response.'),
					},
				};
			}

			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(text),
			}]);

			return {
				metadata: {
					provider: 'nailed',
					model: config.model,
				},
			};
		} catch (error) {
			this.logService.error('[nailed] request failed', error);
			return {
				errorDetails: {
					message: error instanceof Error ? error.message : nls.localize('nailedFailed', 'The configured provider request failed.'),
				},
			};
		}
	}

	private async readConfig(): Promise<NailedProviderConfig> {
		const homePath = env['USERPROFILE'] || env['HOME'];
		const home = homePath ? URI.file(homePath) : undefined;
		if (!home) {
			throw new Error(nls.localize('nailedMissingHome', 'Unable to resolve the current user home directory.'));
		}
		const codexHome = joinPath(home, '.codex');
		const configRaw = (await this.fileService.readFile(joinPath(codexHome, 'config.toml'))).value.toString();
		const authRaw = (await this.fileService.readFile(joinPath(codexHome, 'auth.json'))).value.toString();
		const model = readRequiredTomlString(configRaw, /^model\s*=\s*"([^"]+)"/m, 'model');
		const providerName = readRequiredTomlString(configRaw, /^model_provider\s*=\s*"([^"]+)"/m, 'model_provider');
		const providerBlock = readRequiredProviderBlock(configRaw, providerName);
		const baseUrl = readRequiredTomlString(providerBlock, /^base_url\s*=\s*"([^"]+)"/m, 'base_url').replace(/\/$/, '');
		const auth = JSON.parse(authRaw) as { OPENAI_API_KEY?: string };
		const apiKey = auth.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error(nls.localize('nailedMissingApiKey', 'Missing OPENAI_API_KEY in .codex/auth.json.'));
		}
		return { model, baseUrl, apiKey };
	}

	private async fetchResponse(config: NailedProviderConfig, input: NailedResponsesInputMessage[], token: CancellationToken): Promise<NailedResponsesResult> {
		const controller = new AbortController();
		const listener = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await fetch(`${config.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: config.model,
					input,
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(body || nls.localize('nailedHttpError', 'The provider request failed with status {0}.', response.status));
			}
			return await response.json() as NailedResponsesResult;
		} finally {
			listener.dispose();
		}
	}
}

function toResponsesInput(request: IChatAgentRequest, history: IChatAgentHistoryEntry[]): NailedResponsesInputMessage[] {
	const messages: NailedResponsesInputMessage[] = [];
	for (const entry of history) {
		const userText = entry.request.message.trim();
		if (userText) {
			messages.push(createTextMessage('user', userText));
		}
		const assistantText = extractHistoryText(entry.response);
		if (assistantText) {
			messages.push(createTextMessage('assistant', assistantText));
		}
	}
	messages.push(createTextMessage('user', request.message.trim()));
	return messages;
}

type NailedHistoryResponsePart = IChatProgressHistoryResponseContent | { kind: 'progressTask'; content?: { value: string } };

function extractHistoryText(response: ReadonlyArray<NailedHistoryResponsePart>): string {
	return response.map(part => {
		switch (part.kind) {
			case 'markdownContent':
				return part.content.value;
			case 'progressMessage':
				return part.content.value;
			case 'warning':
				return part.content.value;
			default:
				return '';
		}
	}).filter(value => !!value).join('\n\n').trim();
}

function createTextMessage(role: 'user' | 'assistant', text: string): NailedResponsesInputMessage {
	return {
		role,
		content: [{
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text,
		}]
	};
}

function getResponseText(result: NailedResponsesResult): string {
	const parts: string[] = [];
	for (const item of result.output ?? []) {
		if (item.type !== 'message') {
			continue;
		}
		for (const part of item.content ?? []) {
			if (part.type === 'output_text' && part.text) {
				parts.push(part.text);
			}
		}
	}
	return parts.join('');
}

function readRequiredProviderBlock(configRaw: string, providerName: string): string {
	const blockPattern = new RegExp(`^\\[model_providers\\.${escapeRegex(providerName)}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|$)`, 'm');
	const match = blockPattern.exec(configRaw);
	if (!match?.[1]) {
		throw new Error(nls.localize('nailedMissingProvider', 'Missing provider block for {0}.', providerName));
	}
	return match[1];
}

function readRequiredTomlString(configRaw: string, pattern: RegExp, key: string): string {
	const match = pattern.exec(configRaw);
	if (!match?.[1]) {
		throw new Error(nls.localize('nailedMissingConfig', 'Missing {0} in .codex config.', key));
	}
	return match[1];
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}




