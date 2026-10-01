import { describe, expect, it } from 'vitest';
import type {
	IExecuteSingleFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { CONTROL_STATUS, expectStatus, explainApiError } from './controlResponse';

const context = {
	getNode: () => ({ name: 'Agentova', type: 'n8n-nodes-agentova-ai.agentova' }),
} as unknown as IExecuteSingleFunctions;
const items: INodeExecutionData[] = [{ json: { id: 'aut_1', status: 'paused' } }];
const response = (statusCode: number, body: unknown, headers: Record<string, string> = {}) =>
	({ statusCode, body, headers }) as IN8nHttpFullResponse;

// Le message de l'API (en français jusqu'au draft.6, changeant selon le contrat)
// ne doit jamais être affiché pour un code que le nœud connaît.
const API_MESSAGE = 'API message that must never be shown';
const apiErrorBody = (code: string, details: Record<string, unknown> = {}) => ({
	error: { code, message: API_MESSAGE, details },
});

async function errorOf(promise: Promise<unknown>): Promise<NodeApiError | NodeOperationError> {
	try {
		await promise;
	} catch (error) {
		return error as NodeApiError | NodeOperationError;
	}
	throw new Error('expected the promise to reject');
}

const activate = expectStatus(CONTROL_STATUS.ACTIVE);
const pause = expectStatus(CONTROL_STATUS.PAUSED);

describe('expectStatus (Activate / Pause)', () => {
	it('passes a successful response through untouched when the status is the requested one', async () => {
		const active: INodeExecutionData[] = [{ json: { id: 'aut_1', status: 'active' } }];
		expect(await activate.call(context, active, response(200, active[0].json))).toBe(active);
	});

	it('pausing an already-paused automation stays a plain 200, no error (contract: idempotent)', async () => {
		await expect(
			pause.call(context, items, response(200, { id: 'aut_1', status: 'paused' })),
		).resolves.toBe(items);
	});

	it('fails when Activate gets a 200 with status error (CRM source that could not be resumed)', async () => {
		const body = { id: 'aut_1', name: 'HubSpot leads', status: 'error' };
		const error = await errorOf(activate.call(context, [{ json: body }], response(200, body)));

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe('Automation "HubSpot leads" could not be resumed, now in error');
		expect(error.description).toMatch(/Resume it from the Agentova app/);
	});

	it('fails on any other status than the requested one', async () => {
		const body = { id: 'aut_1', status: 'active' };
		const error = await errorOf(pause.call(context, [{ json: body }], response(200, body)));

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe('The automation is "active" instead of "paused"');
	});

	it('explains automation_not_controllable with the status from the details, in English', async () => {
		const error = await errorOf(
			activate.call(
				context,
				items,
				response(422, apiErrorBody('automation_not_controllable', { status: 'draft' })),
			),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('This automation cannot be controlled through the API');
		expect(error.description).toBe(
			'The automation is in draft. Activate it or fix it once from the Agentova app, then retry.',
		);
	});

	it('no longer announces that Activate and Pause are "not available yet"', async () => {
		const error = await errorOf(
			activate.call(context, items, response(404, apiErrorBody('route_not_found'))),
		);

		expect(error.message).not.toMatch(/not available yet/);
		expect(error.message).toBe('Agentova API route not found');
	});
});

describe('explainApiError (List / Get)', () => {
	it('passes a successful response through untouched', async () => {
		expect(await explainApiError.call(context, items, response(200, { data: [] }))).toBe(items);
	});

	it.each([
		['invalid_request', 400, 'Agentova rejected the request as invalid'],
		['invalid_api_key', 401, 'Invalid or revoked Agentova API key'],
		['workspace_access_denied', 403, 'This Agentova workspace has no access to the API'],
		['automation_not_found', 404, 'Automation not found'],
		['webhook_not_found', 404, 'Webhook subscription not found'],
		['route_not_found', 404, 'Agentova API route not found'],
		['automation_not_controllable', 422, 'This automation cannot be controlled through the API'],
		['rate_limited', 429, 'Agentova rate limit reached, retry later'],
		['internal_error', 500, 'Agentova internal error'],
	])(
		'maps %s (HTTP %i) to its own English message, never the API message',
		async (code, status, message) => {
			const error = await errorOf(
				explainApiError.call(context, items, response(status, apiErrorBody(code))),
			);

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe(message);
			expect((error as NodeApiError).httpCode).toBe(String(status));
			expect(error.description).toBeTruthy();
			expect(`${error.message} ${error.description}`).not.toContain(API_MESSAGE);
		},
	);

	it('shows Retry-After on a 429: "retry in 42 s"', async () => {
		const error = await errorOf(
			explainApiError.call(
				context,
				items,
				response(429, apiErrorBody('rate_limited'), { 'retry-after': '42' }),
			),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('Agentova rate limit reached, retry in 42 s');
	});

	it('falls back to details.retry_after_seconds when the header is missing', async () => {
		const body = apiErrorBody('rate_limited', { retry_after_seconds: 7 });
		const error = await errorOf(explainApiError.call(context, items, response(429, body)));

		expect(error.message).toBe('Agentova rate limit reached, retry in 7 s');
	});

	it('names the rejected parameter of an invalid_request', async () => {
		const body = apiErrorBody('invalid_request', { parameter: 'limit' });
		const error = await errorOf(explainApiError.call(context, items, response(400, body)));

		expect(error.description).toBe('The parameter "limit" is invalid.');
	});

	it('falls back to error.message for a code this node does not know yet', async () => {
		const body = {
			error: { code: 'brand_new_code', message: 'Something new happened', details: {} },
		};
		const error = await errorOf(explainApiError.call(context, items, response(409, body)));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('Something new happened');
	});

	it('points at the Base URL when a 404 does not come from the Agentova API', async () => {
		const fastify404 = {
			message: 'Route GET:/v1/automations not found',
			error: 'Not Found',
			statusCode: 404,
		};
		const error = await errorOf(explainApiError.call(context, items, response(404, fastify404)));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.description).toMatch(/Check the Base URL of the Agentova credential/);
	});
});
