/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { env } from '../../../../../base/common/process.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { invokeNailedRequest } from '../../browser/nailedCoreAgentContribution.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { ILanguageModelChatMetadata, ILanguageModelsService } from '../../common/languageModels.js';
import { IChatAgentRequest } from '../../common/participants/chatAgents.js';
import { IBeginToolCallOptions, ILanguageModelToolsService, IToolData, IToolInvocation } from '../../common/tools/languageModelToolsService.js';
import { InMemoryTestFileService } from '../../../../test/common/workbenchTestServices.js';

const homePath = 'c:\\nailed-test-home';

class TestLogService extends NullLogService {
	readonly warnings: string[] = [];
	readonly errors: string[] = [];

	override warn(message: string, ...args: unknown[]): void {
		this.warnings.push([message, ...args.map(arg => String(arg))].join(' '));
	}

	override error(message: string | Error, ...args: unknown[]): void {
		this.errors.push([String(message), ...args.map(arg => String(arg))].join(' '));
	}
}

suite('NailedCoreAgentContribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let originalUserProfile: string | undefined;
	let originalHome: string | undefined;
	let originalFetch: typeof globalThis.fetch;

	setup(() => {
		originalUserProfile = env['USERPROFILE'];
		originalHome = env['HOME'];
		originalFetch = globalThis.fetch;
		env['USERPROFILE'] = homePath;
		env['HOME'] = homePath;
	});

	teardown(() => {
		env['USERPROFILE'] = originalUserProfile;
		env['HOME'] = originalHome;
		globalThis.fetch = originalFetch;
	});

	test('filters tools, correlates tool calls, and replays provider output items', async () => {
		const fileService = await createFileService();
		const logService = new TestLogService();
		const progressEvents: IChatProgress[] = [];
		const beginCalls: IBeginToolCallOptions[] = [];
		const streamUpdates: Array<{ toolCallId: string; partialInput: unknown }> = [];
		const toolInvocations: IToolInvocation[] = [];
		let selectedModel: ILanguageModelChatMetadata | undefined;

		const modelMetadata = { id: 'selected-model', vendor: 'openai', family: 'gpt-4', version: '1.0' } as ILanguageModelChatMetadata;
		const enabledTool = {
			id: 'gpt4Tool',
			modelDescription: 'Read workspace files',
			displayName: 'Read workspace files',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: true,
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' }
				},
				required: ['path']
			}
		} as unknown as IToolData;
		const disabledTool = {
			id: 'disabledTool',
			modelDescription: 'Disabled tool',
			displayName: 'Disabled tool',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: true
		} as unknown as IToolData;
		const hiddenTool = {
			id: 'hiddenTool',
			modelDescription: 'Hidden infra tool',
			displayName: 'Hidden infra tool',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: false
		} as unknown as IToolData;

		const toolsService = {
			_serviceBrand: undefined,
			getTools: (model: ILanguageModelChatMetadata | undefined) => {
				selectedModel = model;
				return model?.family === 'gpt-4' ? [enabledTool, disabledTool, hiddenTool] : [];
			},
			beginToolCall: (options: IBeginToolCallOptions) => {
				beginCalls.push(options);
				return undefined;
			},
			updateToolStream: async (toolCallId: string, partialInput: unknown) => {
				streamUpdates.push({ toolCallId, partialInput });
			},
			invokeTool: async (invocation: IToolInvocation) => {
				toolInvocations.push(invocation);
				return {
					content: [{ kind: 'text', value: 'tool result' }]
				};
			},
			cancelToolCallsForRequest: () => { },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: (modelId: string) => modelId === 'selected-model' ? modelMetadata : undefined,
		} as unknown as ILanguageModelsService;

		const request = createRequest({
			userSelectedModelId: 'selected-model',
			userSelectedTools: {
				gpt4Tool: true,
				disabledTool: false,
				hiddenTool: true,
			}
		});

		const fetchBodies: any[] = [];
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}'));
			fetchBodies.push(body);

			if (fetchBodies.length === 1) {
				return new Response(JSON.stringify({
					output: [{
						type: 'function_call',
						id: 'response-item-1',
						call_id: 'protocol-call-1',
						name: 'gpt4Tool',
						arguments: JSON.stringify({ path: 'src/index.ts' })
					}]
				}), { status: 200 });
			}

			return new Response(JSON.stringify({
				output: [{
					type: 'message',
					content: [{ type: 'output_text', text: 'All done.' }]
				}]
			}), { status: 200 });
		};

		const result = await invokeNailedRequest(
			request,
			parts => progressEvents.push(...parts),
			[],
			CancellationToken.None,
			fileService,
			logService as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(selectedModel?.id, 'selected-model');
		assert.strictEqual(fetchBodies.length, 2);
		assert.deepStrictEqual(fetchBodies[0].tools.map((tool: { name: string }) => tool.name), ['gpt4Tool']);
		assert.deepStrictEqual(beginCalls, [{
			toolCallId: 'response-item-1',
			toolId: 'gpt4Tool',
			chatRequestId: 'request-1',
			sessionResource: request.sessionResource,
		}]);
		assert.deepStrictEqual(streamUpdates, [{ toolCallId: 'response-item-1', partialInput: { path: 'src/index.ts' } }]);
		assert.strictEqual(toolInvocations.length, 1);
		assert.strictEqual(toolInvocations[0].callId, 'protocol-call-1');
		assert.strictEqual(toolInvocations[0].chatStreamToolCallId, 'response-item-1');
		assert.deepStrictEqual(toolInvocations[0].parameters, { path: 'src/index.ts' });
		assert.ok(fetchBodies[1].input.some((item: { type?: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === 'protocol-call-1'));
		assert.ok(fetchBodies[1].input.some((item: { type?: string; call_id?: string }) => item.type === 'function_call' && item.call_id === 'protocol-call-1'));
		assert.strictEqual(progressEvents.at(-1)?.kind, 'markdownContent');
		assert.deepStrictEqual(result.metadata, { provider: 'nailed', model: 'gpt-4-test' });
		assert.strictEqual(logService.warnings.length, 0);
	});

	test('completes a multi-round loop with an internal tool and an MCP tool', async () => {
		const fileService = await createFileService();
		const toolInvocations: IToolInvocation[] = [];
		const builtInTool = {
			id: 'builtInReadTool',
			modelDescription: 'Read a workspace file',
			displayName: 'Read a workspace file',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: true,
		} as unknown as IToolData;
		const mcpTool = {
			id: 'mcpTool',
			modelDescription: 'Call MCP service',
			displayName: 'Call MCP service',
			source: { type: 'mcp', label: 'mcp', serverLabel: 'Test MCP', instructions: undefined, collectionId: 'test-collection', definitionId: 'test-definition' },
			canBeReferencedInPrompt: true,
		} as unknown as IToolData;

		const toolsService = {
			_serviceBrand: undefined,
			getTools: () => [builtInTool, mcpTool],
			beginToolCall: () => undefined,
			updateToolStream: async () => { },
			invokeTool: async (invocation: IToolInvocation) => {
				toolInvocations.push(invocation);
				return { content: [{ kind: 'text', value: `${invocation.toolId} result` }] };
			},
			cancelToolCallsForRequest: () => { },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: () => undefined,
		} as unknown as ILanguageModelsService;

		const fetchBodies: any[] = [];
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}'));
			fetchBodies.push(body);

			if (fetchBodies.length === 1) {
				return new Response(JSON.stringify({
					output: [{ type: 'function_call', id: 'stream-1', call_id: 'call-1', name: 'builtInReadTool', arguments: '{}' }]
				}), { status: 200 });
			}

			if (fetchBodies.length === 2) {
				assert.ok(body.input.some((item: { type?: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === 'call-1'));
				return new Response(JSON.stringify({
					output: [{ type: 'function_call', id: 'stream-2', call_id: 'call-2', name: 'mcpTool', arguments: '{}' }]
				}), { status: 200 });
			}

			assert.ok(body.input.some((item: { type?: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === 'call-2'));
			return new Response(JSON.stringify({
				output: [{ type: 'message', content: [{ type: 'output_text', text: 'Finished multi-round run' }] }]
			}), { status: 200 });
		};

		const progressEvents: IChatProgress[] = [];
		const result = await invokeNailedRequest(
			createRequest(),
			parts => progressEvents.push(...parts),
			[],
			CancellationToken.None,
			fileService,
			new NullLogService() as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(fetchBodies.length, 3);
		assert.deepStrictEqual(toolInvocations.map(invocation => invocation.toolId), ['builtInReadTool', 'mcpTool']);
		assert.strictEqual(progressEvents.at(-1)?.kind, 'markdownContent');
		assert.deepStrictEqual(result.metadata, { provider: 'nailed', model: 'gpt-4-test' });
	});

	test('returns cancelled when the request is cancelled during the tool loop', async () => {
		const fileService = await createFileService();
		const tokenSource = new CancellationTokenSource();
		let cancelRequestId: string | undefined;

		const tool = {
			id: 'cancelTool',
			modelDescription: 'Cancelable tool',
			displayName: 'Cancelable tool',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: true,
		} as unknown as IToolData;

		const toolsService = {
			_serviceBrand: undefined,
			getTools: () => [tool],
			beginToolCall: () => undefined,
			updateToolStream: async () => { },
			invokeTool: async () => {
				tokenSource.cancel();
				return { content: [{ kind: 'text', value: 'tool result before cancel' }] };
			},
			cancelToolCallsForRequest: (requestId: string) => { cancelRequestId = requestId; },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: () => undefined,
		} as unknown as ILanguageModelsService;

		globalThis.fetch = async () => new Response(JSON.stringify({
			output: [{ type: 'function_call', id: 'cancel-stream', call_id: 'cancel-call', name: 'cancelTool', arguments: '{}' }]
		}), { status: 200 });

		const result = await invokeNailedRequest(
			createRequest({ requestId: 'cancel-request' }),
			() => { },
			[],
			tokenSource.token,
			fileService,
			new NullLogService() as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(result.errorDetails?.message, 'Request cancelled.');
		assert.strictEqual(cancelRequestId, 'cancel-request');
	});

	test('falls back to text-only when selected model metadata cannot be resolved', async () => {
		const fileService = await createFileService();
		const logService = new TestLogService();
		let getToolsCalled = false;
		const fetchBodies: any[] = [];

		const toolsService = {
			_serviceBrand: undefined,
			getTools: () => {
				getToolsCalled = true;
				return [];
			},
			beginToolCall: () => undefined,
			updateToolStream: async () => { },
			invokeTool: async () => ({ content: [{ kind: 'text', value: 'unexpected' }] }),
			cancelToolCallsForRequest: () => { },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: () => undefined,
		} as unknown as ILanguageModelsService;

		globalThis.fetch = async (_input, init) => {
			fetchBodies.push(JSON.parse(String(init?.body ?? '{}')));
			return new Response(JSON.stringify({
				output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fallback text response' }] }]
			}), { status: 200 });
		};

		const result = await invokeNailedRequest(
			createRequest({ userSelectedModelId: 'missing-model' }),
			() => { },
			[],
			CancellationToken.None,
			fileService,
			logService as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(getToolsCalled, false);
		assert.strictEqual(fetchBodies.length, 1);
		assert.strictEqual('tools' in fetchBodies[0], false);
		assert.ok(logService.warnings.some(message => message.includes('Failed to resolve request tools')));
		assert.deepStrictEqual(result.metadata, { provider: 'nailed', model: 'gpt-4-test' });
	});

	test('returns an explicit error when provider omits call_id', async () => {
		const fileService = await createFileService();
		const logService = new TestLogService();
		const tool = {
			id: 'protocolTool',
			modelDescription: 'Protocol tool',
			displayName: 'Protocol tool',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: true,
		} as unknown as IToolData;

		const toolsService = {
			_serviceBrand: undefined,
			getTools: () => [tool],
			beginToolCall: () => undefined,
			updateToolStream: async () => { },
			invokeTool: async () => ({ content: [{ kind: 'text', value: 'unexpected' }] }),
			cancelToolCallsForRequest: () => { },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: () => undefined,
		} as unknown as ILanguageModelsService;

		globalThis.fetch = async () => new Response(JSON.stringify({
			output: [{ type: 'function_call', id: 'missing-call-id', name: 'protocolTool', arguments: '{}' }]
		}), { status: 200 });

		const result = await invokeNailedRequest(
			createRequest(),
			() => { },
			[],
			CancellationToken.None,
			fileService,
			logService as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(result.errorDetails?.message, 'The configured provider returned an unsupported tool response format.');
		assert.ok(logService.warnings.some(message => message.includes('without call_id')));
	});

	test('returns an explicit error when provider nests function_call inside message content', async () => {
		const fileService = await createFileService();
		const logService = new TestLogService();
		const tool = {
			id: 'nestedTool',
			modelDescription: 'Nested protocol tool',
			displayName: 'Nested protocol tool',
			source: { type: 'internal', label: 'internal' },
			canBeReferencedInPrompt: true,
		} as unknown as IToolData;

		const toolsService = {
			_serviceBrand: undefined,
			getTools: () => [tool],
			beginToolCall: () => undefined,
			updateToolStream: async () => { },
			invokeTool: async () => ({ content: [{ kind: 'text', value: 'unexpected' }] }),
			cancelToolCallsForRequest: () => { },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: () => undefined,
		} as unknown as ILanguageModelsService;

		globalThis.fetch = async () => new Response(JSON.stringify({
			output: [{ type: 'message', content: [{ type: 'function_call', text: 'wrong place' }] }]
		}), { status: 200 });

		const result = await invokeNailedRequest(
			createRequest(),
			() => { },
			[],
			CancellationToken.None,
			fileService,
			logService as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(result.errorDetails?.message, 'The configured provider returned an unsupported tool response format.');
		assert.ok(logService.warnings.some(message => message.includes('nested inside message.content')));
	});

	test('falls back to text-only when no tools are available for the request', async () => {
		const fileService = await createFileService();
		const toolInvocations: IToolInvocation[] = [];

		const toolsService = {
			_serviceBrand: undefined,
			getTools: () => [],
			beginToolCall: () => undefined,
			updateToolStream: async () => { },
			invokeTool: async (invocation: IToolInvocation) => {
				toolInvocations.push(invocation);
				return { content: [{ kind: 'text', value: 'unexpected' }] };
			},
			cancelToolCallsForRequest: () => { },
			flushToolUpdates: () => { },
		} as unknown as ILanguageModelToolsService;

		const languageModelsService = {
			_serviceBrand: undefined,
			lookupLanguageModel: () => undefined,
		} as unknown as ILanguageModelsService;

		const fetchBodies: any[] = [];
		globalThis.fetch = async (_input, init) => {
			fetchBodies.push(JSON.parse(String(init?.body ?? '{}')));
			return new Response(JSON.stringify({
				output: [{
					type: 'message',
					content: [{ type: 'output_text', text: 'Plain text response' }]
				}]
			}), { status: 200 });
		};

		const result = await invokeNailedRequest(
			createRequest(),
			() => { },
			[],
			CancellationToken.None,
			fileService,
			new NullLogService() as ILogService,
			toolsService,
			languageModelsService,
		);

		assert.strictEqual(fetchBodies.length, 1);
		assert.strictEqual('tools' in fetchBodies[0], false);
		assert.strictEqual(toolInvocations.length, 0);
		assert.deepStrictEqual(result.metadata, { provider: 'nailed', model: 'gpt-4-test' });
	});
});

function createRequest(overrides?: Partial<IChatAgentRequest>): IChatAgentRequest {
	return {
		sessionResource: URI.parse('test://session/1'),
		requestId: 'request-1',
		agentId: 'nailed.chat.core',
		message: 'Use the tool if needed',
		variables: { variables: [] },
		location: ChatAgentLocation.Chat,
		...overrides,
	};
}

async function createFileService(): Promise<IFileService> {
	const fileService = new InMemoryTestFileService();
	await fileService.writeFile(URI.file(`${homePath}\\.codex\\config.toml`), VSBuffer.fromString([
		'model = "gpt-4-test"',
		'model_provider = "nailed"',
		'',
		'[model_providers.nailed]',
		'base_url = "https://api.example.com"',
	].join('\n')));
	await fileService.writeFile(URI.file(`${homePath}\\.codex\\auth.json`), VSBuffer.fromString(JSON.stringify({ OPENAI_API_KEY: 'test-key' })));
	return fileService;
}
