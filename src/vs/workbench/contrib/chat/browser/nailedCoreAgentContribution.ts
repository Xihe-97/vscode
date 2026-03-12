/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { env } from '../../../../base/common/process.js';
import { joinPath } from '../../../../base/common/resources.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import * as nls from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, asText, IRequestService } from '../../../../platform/request/common/request.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IChatProgress } from '../common/chatService/chatService.js';
import { ILanguageModelChatMetadata, ILanguageModelsService } from '../common/languageModels.js';
import { IChatProgressHistoryResponseContent } from '../common/model/chatModel.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../common/constants.js';
import { CountTokensCallback, ILanguageModelToolsService, IToolData, IToolInvocation, IToolInvocationContext, IToolResult } from '../common/tools/languageModelToolsService.js';

const NAILED_AGENT_ID = 'nailed.chat.core';
const MAX_TOOL_CALL_ITERATIONS = 16;

interface NailedProviderConfig {
	readonly model: string;
	readonly baseUrl: string;
	readonly apiKey: string;
}

interface ResponsesTextInputMessage {
	role: 'user' | 'assistant';
	content: Array<{
		type: 'input_text' | 'output_text';
		text: string;
	}>;
}

interface ResponsesToolDefinition {
	type: 'function';
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: false;
}

interface ResponsesFunctionCall {
	type: 'function_call';
	id: string;
	call_id?: string;
	name: string;
	arguments: string;
	status?: string;
}

interface ResponsesFunctionCallOutput {
	type: 'function_call_output';
	call_id: string;
	output: string;
}

interface ResponsesMessageOutput {
	type: 'message';
	role?: 'assistant';
	content?: Array<{
		type?: string;
		text?: string;
	}>;
}

interface ResponsesUnknownOutput {
	type?: string;
}

type ResponsesOutputItem = ResponsesMessageOutput | ResponsesFunctionCall | ResponsesUnknownOutput;
type ResponsesInputItem = ResponsesTextInputMessage | ResponsesFunctionCallOutput | ResponsesOutputItem;

interface ResponsesResult {
	output?: ResponsesOutputItem[];
}

export class NailedCoreAgentContribution extends Disposable implements IWorkbenchContribution {

	public static readonly ID = 'workbench.contrib.chat.nailedCoreAgent';

	constructor(
		@IChatAgentService chatAgentService: IChatAgentService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();

		let requestService: IRequestService | undefined;
		try {
			requestService = new RequestChannelClient(mainProcessService.getChannel('request'));
		} catch {
			requestService = undefined;
		}

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

		this._register(chatAgentService.registerAgentImplementation(NAILED_AGENT_ID, new NailedCoreAgent(fileService, logService, languageModelToolsService, languageModelsService, requestService)));
	}
}

export async function invokeNailedRequest(
	request: IChatAgentRequest,
	progress: (parts: IChatProgress[]) => void,
	history: IChatAgentHistoryEntry[],
	token: CancellationToken,
	fileService: IFileService,
	logService: ILogService,
	toolsService: ILanguageModelToolsService,
	languageModelsService: ILanguageModelsService,
	requestService?: IRequestService,
): Promise<IChatAgentResult> {
	const agent = new NailedCoreAgent(fileService, logService, toolsService, languageModelsService, requestService);
	try {
		return await agent.invoke(request, progress, history, token);
	} finally {
		agent.dispose();
	}
}

class NailedCoreAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly toolsService: ILanguageModelToolsService,
		private readonly languageModelsService: ILanguageModelsService,
		private readonly requestService?: IRequestService,
	) {
		super();
	}

	private logPrefix(request: IChatAgentRequest): string {
		return `[nailed][request:${request.requestId}]`;
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		try {
			const availableTools = this.resolveAvailableTools(request);
			if (availableTools.length === 0) {
				this.logService.info(`${this.logPrefix(request)} No available tools for this request, falling back to text-only mode`);
				return this.invokeTextOnly(request, progress, history, token);
			}

			this.logService.info(`${this.logPrefix(request)} Exposing ${availableTools.length} tool(s) to the provider`);
			return this.invokeWithTools(request, progress, history, token, availableTools);
		} catch (error) {
			this.logService.warn(`${this.logPrefix(request)} Failed to resolve request tools, falling back to text-only mode`, error);
			return this.invokeTextOnly(request, progress, history, token);
		}
	}

	private resolveAvailableTools(request: IChatAgentRequest): IToolData[] {
		const selectedModel = this.resolveSelectedModel(request);
		const promptableTools = Array.from(this.toolsService.getTools(selectedModel)).filter(tool => tool.canBeReferencedInPrompt !== false);
		const disabledByUser = request.userSelectedTools
			? promptableTools.filter(tool => request.userSelectedTools![tool.id] === false).map(tool => tool.id)
			: [];
		const filteredTools = request.userSelectedTools
			? promptableTools.filter(tool => request.userSelectedTools![tool.id] !== false)
			: promptableTools;

		this.logService.debug(`${this.logPrefix(request)} Tool selection resolved { selectedModel: ${selectedModel?.id ?? 'none'}, promptable: ${promptableTools.length}, exposed: ${filteredTools.length}, toolIds: [${filteredTools.map(tool => tool.id).join(', ')}], disabledByUser: [${disabledByUser.join(', ')}] }`);
		this.logService.info(`${this.logPrefix(request)} Exposed tool details ${JSON.stringify(filteredTools.map(tool => ({
			id: tool.id,
			displayName: tool.displayName,
			canBeReferencedInPrompt: tool.canBeReferencedInPrompt,
			modelDescription: tool.modelDescription,
			source: typeof tool.source === 'string' ? tool.source : tool.source?.type,
		})))}`);
		return filteredTools;
	}

	private resolveSelectedModel(request: IChatAgentRequest): ILanguageModelChatMetadata | undefined {
		if (!request.userSelectedModelId) {
			return undefined;
		}

		const selectedModel = this.languageModelsService.lookupLanguageModel(request.userSelectedModelId);
		if (!selectedModel) {
			throw new Error(nls.localize('nailedMissingModelMetadata', 'Could not resolve metadata for the selected model {0}.', request.userSelectedModelId));
		}

		return selectedModel;
	}

	private async invokeTextOnly(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		progress([{
			kind: 'progressMessage',
			content: new MarkdownString(nls.localize('nailedConnecting', 'Connecting to Nailed...')),
			shimmer: true,
		}]);

		try {
			const config = await this.readConfig();
			const input = toResponsesInput(request, history);
			const response = await this.fetchResponses(config, input, undefined, token);
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
			this.logService.error(`${this.logPrefix(request)} request failed`, error);
			return {
				errorDetails: {
					message: error instanceof Error ? error.message : nls.localize('nailedFailed', 'The configured provider request failed.'),
				},
			};
		}
	}

	private async invokeWithTools(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
		availableTools: IToolData[],
	): Promise<IChatAgentResult> {
		progress([{
			kind: 'progressMessage',
			content: new MarkdownString(nls.localize('nailedConnecting', 'Connecting to Nailed with tools...')),
			shimmer: true,
		}]);

		try {
			const config = await this.readConfig();
			const toolDefinitions = availableTools.map(tool => convertToolToResponsesDefinition(tool, this.logService));
			let inputItems: ResponsesInputItem[] = [...toResponsesInput(request, history)];
			let iteration = 0;

			while (!token.isCancellationRequested) {
				const response = await this.fetchResponses(config, inputItems, toolDefinitions, token);
				const protocolIssue = getProtocolResponseIssue(response);
				if (protocolIssue) {
					this.logService.warn(`${this.logPrefix(request)} ${protocolIssue}`);
					this.toolsService.cancelToolCallsForRequest(request.requestId);
					return {
						errorDetails: {
							message: nls.localize('nailedInvalidToolResponse', 'The configured provider returned an unsupported tool response format.'),
						},
					};
				}

				const functionCalls = getFunctionCalls(response);

				if (functionCalls.length === 0) {
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
				}

				iteration++;
				if (iteration > MAX_TOOL_CALL_ITERATIONS) {
					throw new Error(nls.localize('nailedTooManyToolIterations', 'The configured provider exceeded the maximum number of tool iterations.'));
				}

				this.logService.info(`${this.logPrefix(request)} Executing ${functionCalls.length} tool call(s) in iteration ${iteration}`);
				const toolOutputs: ResponsesFunctionCallOutput[] = [];

				for (const call of functionCalls) {
					try {
						const result = await this.executeToolCall(call, request, token);
						toolOutputs.push(convertToolResultToResponsesInput(this.getProtocolCallId(call), result));
					} catch (toolError) {
						if (token.isCancellationRequested || isCancellationError(toolError)) {
							throw toolError;
						}

						this.logService.error(`${this.logPrefix(request)} Tool ${call.name} failed`, toolError);
						toolOutputs.push({
							type: 'function_call_output',
							call_id: this.getProtocolCallId(call),
							output: JSON.stringify({ error: toolError instanceof Error ? toolError.message : 'Tool execution failed' }),
						});
					}
				}

				inputItems = [
					...inputItems,
					...(response.output ?? []),
					...toolOutputs,
				];
			}

			this.toolsService.cancelToolCallsForRequest(request.requestId);
			return {
				errorDetails: {
					message: nls.localize('nailedCancelled', 'Request cancelled.'),
				},
			};
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				this.toolsService.cancelToolCallsForRequest(request.requestId);
				return {
					errorDetails: {
						message: nls.localize('nailedCancelled', 'Request cancelled.'),
					},
				};
			}

			this.logService.error(`${this.logPrefix(request)} request failed`, error);
			return {
				errorDetails: {
					message: error instanceof Error ? error.message : nls.localize('nailedFailed', 'The configured provider request failed.'),
				},
			};
		}
	}

	private getProtocolCallId(call: ResponsesFunctionCall): string {
		if (!call.call_id) {
			throw new Error(nls.localize('nailedMissingCallId', 'Function call {0} is missing call_id.', call.name));
		}

		return call.call_id;
	}

	private async executeToolCall(call: ResponsesFunctionCall, request: IChatAgentRequest, token: CancellationToken): Promise<IToolResult> {
		let parameters: Record<string, unknown>;
		try {
			const parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {};
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('Tool arguments must be a JSON object');
			}

			parameters = parsed;
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : 'Invalid tool arguments: not valid JSON');
		}

		const context: IToolInvocationContext = {
			sessionResource: request.sessionResource,
		};
		const streamCorrelationId = call.id;

		this.toolsService.beginToolCall({
			toolCallId: streamCorrelationId,
			toolId: call.name,
			chatRequestId: request.requestId,
			sessionResource: request.sessionResource,
		});
		await this.toolsService.updateToolStream(streamCorrelationId, parameters, token);

		const invocation: IToolInvocation = {
			callId: this.getProtocolCallId(call),
			toolId: call.name,
			parameters,
			context,
			chatRequestId: request.requestId,
			chatStreamToolCallId: streamCorrelationId,
		};

		const countTokens: CountTokensCallback = async () => 0;
		return this.toolsService.invokeTool(invocation, countTokens, token);
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

	private async fetchResponses(
		config: NailedProviderConfig,
		input: ResponsesInputItem[],
		tools: ResponsesToolDefinition[] | undefined,
		token: CancellationToken,
	): Promise<ResponsesResult> {
		const requestBody: Record<string, unknown> = {
			model: config.model,
			input,
		};

		if (tools?.length) {
			requestBody.tools = tools;
		}

		if (this.requestService) {
			const context = await this.requestService.request({
				type: 'POST',
				url: `${config.baseUrl}/responses`,
				headers: {
					'Authorization': `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json',
				},
				data: JSON.stringify(requestBody),
			}, token);

			if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
				const body = await asText(context);
				throw new Error(body || nls.localize('nailedHttpError', 'The provider request failed with status {0}.', context.res.statusCode ?? 'unknown'));
			}

			return await asJson<ResponsesResult>(context) ?? {};
		}

		const controller = new AbortController();
		const listener = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await fetch(`${config.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(body || nls.localize('nailedHttpError', 'The provider request failed with status {0}.', response.status));
			}
			return await response.json() as ResponsesResult;
		} finally {
			listener.dispose();
		}
	}
}

function toResponsesInput(request: IChatAgentRequest, history: IChatAgentHistoryEntry[]): ResponsesTextInputMessage[] {
	const messages: ResponsesTextInputMessage[] = [];
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

function createTextMessage(role: 'user' | 'assistant', text: string): ResponsesTextInputMessage {
	return {
		role,
		content: [{
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text,
		}]
	};
}

function getResponseText(result: ResponsesResult): string {
	const parts: string[] = [];
	for (const item of result.output ?? []) {
		if (item.type !== 'message') {
			continue;
		}
		const message = item as ResponsesMessageOutput;
		for (const part of message.content ?? []) {
			if (part.type === 'output_text' && part.text) {
				parts.push(part.text);
			}
		}
	}
	return parts.join('');
}

function getProtocolResponseIssue(result: ResponsesResult): string | undefined {
	for (const item of result.output ?? []) {
		if (item.type === 'function_call') {
			const call = item as ResponsesFunctionCall;
			if (!call.call_id) {
				return `Provider returned function_call ${call.name} without call_id`;
			}
			continue;
		}

		if (item.type === 'message') {
			const message = item as ResponsesMessageOutput;
			for (const part of message.content ?? []) {
				if (part.type === 'function_call') {
					return 'Provider returned function_call nested inside message.content instead of response.output[]';
				}
			}
		}
	}

	return undefined;
}

// ============================================================================
// Phase 2: 工具协议转换 - 工具定义转换
// ============================================================================

/**
 * 将 VS Code IToolData 转换为 /responses 协议的工具定义
 */
function convertToolToResponsesDefinition(tool: { id: string; modelDescription: string; inputSchema?: IJSONSchema }, logService: ILogService): ResponsesToolDefinition {
	return {
		type: 'function',
		name: tool.id,
		description: tool.modelDescription,
		parameters: convertJsonSchema(tool.inputSchema, tool.id, logService),
		strict: false,
	};
}

/**
 * 将 IJSONSchema 转换为 /responses 协议可用的参数 schema
 * 处理常见场景，对复杂特性做降级处理
 */
function convertJsonSchema(schema: IJSONSchema | undefined, toolId: string, logService: ILogService): Record<string, unknown> {
	if (!schema) {
		return { type: 'object', properties: {} };
	}

	const result: Record<string, unknown> = {};

		// 处理 type - 转换为 OpenAI 格式
	if (schema.type) {
		if (Array.isArray(schema.type)) {
			// 多个类型的情况，尝试取第一个或使用 object 作为兜底
			const primaryType = schema.type[0];
			result.type = primaryType === 'null' ? 'object' : primaryType;
		} else {
			result.type = schema.type === 'null' ? 'object' : schema.type;
		}
	} else {
		result.type = 'object';
	}

	// 处理 description
	if (schema.description) {
		result.description = schema.description;
	}

	// 处理 properties - 对象参数
	if (schema.properties) {
		result.properties = {};
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			(result.properties as Record<string, unknown>)[key] = convertJsonSchema(propSchema, `${toolId}.${key}`, logService);
		}
	} else if (result.type === 'object') {
		result.properties = {};
	}

	// 处理 required - 必填参数列表
	if (schema.required && Array.isArray(schema.required) && schema.required.length > 0) {
		result.required = schema.required;
	}

	// 处理 items - 数组元素类型
	if (schema.items) {
		if (Array.isArray(schema.items)) {
			result.items = schema.items.map((s, index) => convertJsonSchema(s, `${toolId}[${index}]`, logService));
		} else {
			result.items = convertJsonSchema(schema.items, `${toolId}[]`, logService);
		}
	}

	if (schema.additionalProperties !== undefined) {
		result.additionalProperties = schema.additionalProperties;
	}

	if (schema.default !== undefined) {
		result.default = schema.default;
	}

	if (schema.enum) {
		result.enum = schema.enum;
	}

	if (schema.const !== undefined) {
		result.const = schema.const;
	}

	// 处理常见约束 - 做日志级别的降级，不阻塞
	const unsupportedFeatures: string[] = [];

	// $ref - 引用其他 schema，暂不支持
	if (schema.$id || schema.$ref) {
		unsupportedFeatures.push('$ref/$id');
	}

	// anyOf/oneOf - 联合类型，暂不支持
	if (schema.anyOf || schema.oneOf) {
		unsupportedFeatures.push('anyOf/oneOf');
	}

	// patternProperties - 正则属性，暂不支持
	if (schema.patternProperties) {
		unsupportedFeatures.push('patternProperties');
	}

	// 数值约束
	if (schema.minimum !== undefined || schema.maximum !== undefined || schema.multipleOf !== undefined) {
		unsupportedFeatures.push('numeric constraints (minimum/maximum/multipleOf)');
	}

	// 字符串约束
	if (schema.pattern || schema.minLength !== undefined || schema.maxLength !== undefined) {
		unsupportedFeatures.push('string constraints (pattern/minLength/maxLength)');
	}

	// 数组约束
	if (schema.minItems !== undefined || schema.maxItems !== undefined || schema.uniqueItems) {
		unsupportedFeatures.push('array constraints (minItems/maxItems/uniqueItems)');
	}

	if (unsupportedFeatures.length > 0) {
		logService.warn(`[nailed] Tool schema for ${toolId} has unsupported features: ${unsupportedFeatures.join(', ')}`);
	}

	return result;
}

/**
 * 从 /responses 响应中提取所有工具调用
 */
function getFunctionCalls(result: ResponsesResult): ResponsesFunctionCall[] {
	return (result.output ?? []).filter((item): item is ResponsesFunctionCall => {
		return item.type === 'function_call' && typeof (item as ResponsesFunctionCall).name === 'string' && typeof (item as ResponsesFunctionCall).arguments === 'string';
	});
}

// ============================================================================
// Phase 2: 工具协议转换 - 工具结果回填
// ============================================================================

/**
 * 将工具执行结果转换为 /responses 协议的后续输入格式
 */
function convertToolResultToResponsesInput(callId: string, result: IToolResult): ResponsesFunctionCallOutput {
	const output = serializeToolResult(result);
	return {
		type: 'function_call_output',
		call_id: callId,
		output,
	};
}

/**
 * 统一序列化工具结果（包括文本、数据和错误结果）
 */
function serializeToolResult(result: IToolResult): string {
	// 如果工具执行出错，返回错误信息
	if (result.toolResultError) {
		const errorMsg = typeof result.toolResultError === 'string' ? result.toolResultError : 'Tool execution failed';
		return JSON.stringify({ error: errorMsg });
	}

	const parts: string[] = [];

	for (const part of result.content) {
		switch (part.kind) {
			case 'text':
				// 文本结果直接返回
				if (part.value) {
					parts.push(part.value);
				}
				break;
			case 'data':
				// 数据结果序列化为 JSON
				if (part.value) {
					parts.push(JSON.stringify({
						mimeType: part.value.mimeType,
						data: part.value.data,
					}));
				}
				break;
			case 'promptTsx':
				// promptTsx 类型尝试序列化
				parts.push(JSON.stringify(part));
				break;
			// 忽略其他类型
		}
	}

	// 如果没有内容，返回空对象
	if (parts.length === 0) {
		return JSON.stringify({ result: 'No content' });
	}

	return parts.join('\n');
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
