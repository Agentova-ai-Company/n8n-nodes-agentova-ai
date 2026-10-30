import { describe, expect, it } from 'vitest';
import type { INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { agentovaErrorCodeOf, parseRetryAfter, toNodeApiError } from './apiError';

const node = { name: 'Agentova Trigger', type: 'n8n-nodes-agentova-ai.agentovaTrigger' } as INode;

// Forme RÉELLE d'une erreur HTTP dans n8n (mesurée) : une AxiosError qui porte
// `status` et `response`, sans `statusCode` ni `httpCode`.
function axiosError(status: number, data: unknown, headers: Record<string, string> = {}) {
	return {
		isAxiosError: true,
		status,
		message: `Request failed with status code ${status}`,
		response: { status, data, headers },
	};
}

const API_MESSAGE = 'API message that must never be shown';
const body = (code: string, details: Record<string, unknown> = {}) => ({
	error: { code, message: API_MESSAGE, details },
});

describe('toNodeApiError (requests sent by the trigger and the automation search)', () => {
	it('picks the English text from error.code, never the API message', () => {
		const error = toNodeApiError(node, axiosError(401, body('invalid_api_key')));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('Invalid or revoked Agentova API key');
		expect(error.httpCode).toBe('401');
		// Une AxiosError passée telle quelle à NodeApiError ferait remplacer la
		// description par `response.data.error.message` : c'est ce qu'on vérifie.
		expect(error.description).toMatch(/Settings > API/);
		expect(`${error.message} ${error.description}`).not.toContain(API_MESSAGE);
	});

	it('shows Retry-After on a 429: "retry in 42 s"', () => {
		const error = toNodeApiError(
			node,
			axiosError(429, body('rate_limited'), { 'retry-after': '42' }),
		);

		expect(error.message).toBe('Agentova rate limit reached, retry in 42 s');
		expect(error.httpCode).toBe('429');
	});

	it('explains a webhook URL refused by Agentova (https_required)', () => {
		const error = toNodeApiError(
			node,
			axiosError(400, body('invalid_request', { parameter: 'url', reason: 'https_required' })),
		);

		expect(error.message).toBe('Agentova rejected the request as invalid');
		expect(error.description).toMatch(/only delivers events to HTTPS addresses/);
	});

	it('explains a resume refused because another agent uses the mailbox (account_in_use)', () => {
		const error = toNodeApiError(
			node,
			axiosError(
				422,
				body('automation_not_controllable', { status: 'paused', reason: 'account_in_use' }),
			),
		);

		expect(error.message).toBe('This mailbox is already used by another active Agentova agent');
		expect(error.description).toMatch(/one active agent/);
	});

	it('explains that the API is switched off (503 service_unavailable)', () => {
		const error = toNodeApiError(node, axiosError(503, body('service_unavailable')));

		expect(error.message).toBe('The Agentova API is temporarily unavailable');
		expect(error.httpCode).toBe('503');
	});

	it('explains the cap of active webhook subscriptions (details.max)', () => {
		const error = toNodeApiError(node, axiosError(400, body('invalid_request', { max: 20 })));

		expect(error.description).toMatch(/maximum number of active webhook subscriptions \(20\)/);
	});

	it('reads the error code through a wrapping error (cause chain)', () => {
		const wrapped = { message: 'wrapped', cause: axiosError(403, body('workspace_access_denied')) };

		expect(toNodeApiError(node, wrapped).message).toBe(
			'This Agentova workspace has no access to the API',
		);
	});

	// Ce que lève VRAIMENT `httpRequestWithAuthentication` de n8n-core : la
	// VRAIE AxiosError (une instance d'Error) enveloppée dans un NodeApiError.
	// n8n-workflow ne la garde en `cause` que si c'est une Error : un objet nu
	// perdrait les en-têtes, donc `Retry-After`.
	class AxiosError extends Error {
		readonly isAxiosError = true;
		constructor(
			readonly status: number,
			readonly response: { status: number; data: unknown; headers: Record<string, string> },
		) {
			super(`Request failed with status code ${status}`);
		}
	}

	it('reads the error code and Retry-After through the NodeApiError that n8n-core throws', () => {
		const notFound = new NodeApiError(
			node,
			new AxiosError(404, { status: 404, data: body('webhook_not_found'), headers: {} }),
		);
		expect(agentovaErrorCodeOf(notFound)).toBe('webhook_not_found');

		const throttled = new NodeApiError(
			node,
			new AxiosError(429, {
				status: 429,
				data: body('rate_limited'),
				headers: { 'retry-after': '42' },
			}),
		);
		expect(toNodeApiError(node, throttled).message).toBe(
			'Agentova rate limit reached, retry in 42 s',
		);
	});

	it('leaves an error that does not come from the Agentova API to n8n', () => {
		const error = toNodeApiError(node, axiosError(502, '<html>Bad gateway</html>'));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.httpCode).toBe('502');
	});
});

describe('parseRetryAfter', () => {
	it.each([
		['42', 42],
		[42, 42],
		[['42'], 42],
		['0', 0],
		['', undefined],
		['soon', undefined],
		['1.5', undefined],
		['-1', undefined],
		[undefined, undefined],
	])('reads %j as %j', (value, expected) => {
		expect(parseRetryAfter(value)).toBe(expected);
	});
});
