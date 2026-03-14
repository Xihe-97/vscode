/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface ProviderConfig {
	readonly providerName: string;
	readonly vendor: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly maxInputTokens: number;
}

const CODEX_HOME = path.join(os.homedir(), '.codex');
const CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
const AUTH_PATH = path.join(CODEX_HOME, 'auth.json');

export async function loadProviderConfig(): Promise<ProviderConfig> {
	const configRaw = await fs.readFile(CONFIG_PATH, 'utf8');
	const providerName = readRequiredTomlString(configRaw, /^model_provider\s*=\s*"([^"]+)"/m, 'model_provider');
	const model = readRequiredTomlString(configRaw, /^model\s*=\s*"([^"]+)"/m, 'model');
	const baseUrl = readRequiredTomlString(
		readRequiredProviderBlock(configRaw, providerName),
		/^base_url\s*=\s*"([^"]+)"/m,
		'base_url',
	);
	const maxInputTokens = readOptionalTomlNumber(configRaw, /^model_context_window\s*=\s*(\d+)/m) ?? 1000000;
	const authRaw = await fs.readFile(AUTH_PATH, 'utf8');
	const authJson = JSON.parse(authRaw) as { OPENAI_API_KEY?: string };
	const apiKey = process.env.OPENAI_API_KEY || authJson.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('Missing OPENAI_API_KEY in environment or auth.json.');
	}

	return {
		providerName,
		vendor: providerName,
		model,
		baseUrl: baseUrl.replace(/\/$/, ''),
		apiKey,
		maxInputTokens,
	};
}

function readRequiredProviderBlock(configRaw: string, providerName: string): string {
	const blockPattern = new RegExp(`^\\[model_providers\\.${escapeRegex(providerName)}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|$)`, 'm');
	const match = blockPattern.exec(configRaw);
	if (!match) {
		throw new Error(`Missing provider block for ${providerName}.`);
	}
	return match[1];
}

function readRequiredTomlString(configRaw: string, pattern: RegExp, key: string): string {
	const match = pattern.exec(configRaw);
	if (!match?.[1]) {
		throw new Error(`Missing ${key} in config.`);
	}
	return match[1];
}

function readOptionalTomlNumber(configRaw: string, pattern: RegExp): number | undefined {
	const match = pattern.exec(configRaw);
	if (!match?.[1]) {
		return undefined;
	}
	const value = Number.parseInt(match[1], 10);
	return Number.isFinite(value) ? value : undefined;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
