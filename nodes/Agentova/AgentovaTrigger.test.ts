import { describe, expect, it, vi } from 'vitest';
import type { IHookFunctions, IWebhookFunctions } from 'n8n-workflow';
import { createHmac } from 'crypto';
import { AgentovaTrigger } from './AgentovaTrigger.node';

function fakeWebhookContext(options: {
	webhookSecret?: string;
	signatureHeader?: string;
	rawBody?: Buffer;
	bodyData?: Record<string, unknown>;
}) {
	const staticData: Record<string, unknown> = {};
	if (options.webhookSecret) staticData.webhookSecret = options.webhookSecret;

	const statusMock = vi.fn().mockReturnThis();
	const sendMock = vi.fn().mockReturnThis();
	const endMock = vi.fn();

	const context = {
		getWorkflowStaticData: () => staticData,
		getHeaderData: () => (options.signatureHeader ? { 'x-agentova-signature': options.signatureHeader } : {}),
		getRequestObject: () => ({ rawBody: options.rawBody }),
		getResponseObject: () => ({ status: statusMock, send: sendMock, end: endMock }),
		getBodyData: () => options.bodyData ?? {},
	} as unknown as IWebhookFunctions;

	return { context, statusMock, sendMock, endMock };
}

function signedHeader(timestamp: number, rawBody: Buffer, secret: string): string {
	const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString()}`).digest('hex');
	return `t=${timestamp},v1=${signature}`;
}

function fakeContext(options: {
	webhookId?: string;
	webhookSecret?: string;
	events?: string[];
	httpImpl?: (...args: unknown[]) => unknown;
}) {
	const staticData: Record<string, unknown> = {};
	if (options.webhookId) staticData.webhookId = options.webhookId;
	if (options.webhookSecret) staticData.webhookSecret = options.webhookSecret;

	const httpRequestWithAuthentication = vi.fn(
		options.httpImpl ?? (() => Promise.resolve({ id: 'wh_123', secret: 'whsec_test123' })),
	);

	const context = {
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => 'https://n8n.example.com/webhook/abc',
		getNodeParameter: () => options.events ?? [],
		getCredentials: vi.fn().mockResolvedValue({ baseUrl: 'https://api.agentova.ai/v1' }),
		getNode: () => ({ name: 'Agentova Trigger' }),
		helpers: { httpRequestWithAuthentication },
	} as unknown as IHookFunctions;

	return { context, staticData, httpRequestWithAuthentication };
}

describe('AgentovaTrigger webhookMethods', () => {
	const { webhookMethods } = new AgentovaTrigger();

	describe('checkExists', () => {
		it('returns false when no webhook is registered yet', async () => {
			const { context } = fakeContext({});
			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
		});

		it('returns true when a webhook id is already stored and still active (no duplicate on restart)', async () => {
			const { context } = fakeContext({
				webhookId: 'wh_123',
				httpImpl: () => Promise.resolve({ data: [{ id: 'wh_123', disabled_at: null }] }),
			});
			expect(await webhookMethods.default.checkExists.call(context)).toBe(true);
		});

		it('returns false and clears static data when the stored id is no longer in the list', async () => {
			const { context, staticData } = fakeContext({
				webhookId: 'wh_123',
				webhookSecret: 'whsec_test123',
				httpImpl: () => Promise.resolve({ data: [] }),
			});
			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(staticData.webhookId).toBeUndefined();
			expect(staticData.webhookSecret).toBeUndefined();
		});

		it('returns false and clears static data when the subscription was disabled after prolonged delivery failures', async () => {
			const { context, staticData } = fakeContext({
				webhookId: 'wh_123',
				webhookSecret: 'whsec_test123',
				httpImpl: () => Promise.resolve({ data: [{ id: 'wh_123', disabled_at: '2026-09-01T00:00:00Z' }] }),
			});
			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(staticData.webhookId).toBeUndefined();
		});

		it('tolerates route_not_found (route not yet served by the real API) and keeps the existing subscription', async () => {
			const { context, staticData } = fakeContext({
				webhookId: 'wh_123',
				httpImpl: () => Promise.reject({ statusCode: 404 }),
			});
			expect(await webhookMethods.default.checkExists.call(context)).toBe(true);
			expect(staticData.webhookId).toBe('wh_123');
		});
	});

	describe('create', () => {
		it('subscribes with the node webhook URL and selected events, stores the returned id', async () => {
			const { context, staticData, httpRequestWithAuthentication } = fakeContext({
				events: ['lead.created', 'run.completed'],
			});

			const result = await webhookMethods.default.create.call(context);

			expect(result).toBe(true);
			expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
				'agentovaApi',
				expect.objectContaining({
					method: 'POST',
					url: '/webhooks',
					body: { url: 'https://n8n.example.com/webhook/abc', events: ['lead.created', 'run.completed'] },
				}),
			);
			expect(staticData.webhookId).toBe('wh_123');
			expect(staticData.webhookSecret).toBe('whsec_test123');
		});

		it('throws NodeApiError when the response is missing id or secret', async () => {
			const { context } = fakeContext({
				events: ['lead.created'],
				httpImpl: () => Promise.resolve({ id: 'wh_123' }),
			});

			await expect(webhookMethods.default.create.call(context)).rejects.toThrow();
		});
	});

	describe('delete', () => {
		it('unsubscribes using the stored id and clears static data', async () => {
			const { context, staticData, httpRequestWithAuthentication } = fakeContext({
				webhookId: 'wh_123',
				webhookSecret: 'whsec_test123',
			});

			const result = await webhookMethods.default.delete.call(context);

			expect(result).toBe(true);
			expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
				'agentovaApi',
				expect.objectContaining({ method: 'DELETE', url: '/webhooks/wh_123' }),
			);
			expect(staticData.webhookId).toBeUndefined();
			expect(staticData.webhookSecret).toBeUndefined();
		});

		it('is a no-op when no webhook was ever created', async () => {
			const { context, httpRequestWithAuthentication } = fakeContext({});

			expect(await webhookMethods.default.delete.call(context)).toBe(true);
			expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
		});

		it('treats a 404 (already deleted) as success, not an error (contrat §4)', async () => {
			const { context, staticData } = fakeContext({
				webhookId: 'wh_123',
				httpImpl: () => Promise.reject({ statusCode: 404 }),
			});

			expect(await webhookMethods.default.delete.call(context)).toBe(true);
			expect(staticData.webhookId).toBeUndefined();
		});

		it('wraps any other error in NodeApiError instead of throwing it raw', async () => {
			const { context } = fakeContext({
				webhookId: 'wh_123',
				httpImpl: () => Promise.reject({ statusCode: 500, message: 'boom' }),
			});

			await expect(webhookMethods.default.delete.call(context)).rejects.toThrow();
		});
	});
});

describe('AgentovaTrigger webhook (event delivery)', () => {
	const { webhook } = new AgentovaTrigger();
	const secret = 'whsec_test123';
	const payload = { id: 'evt_01HZX7B2C3D4E5F6G7H8J9K0L1', type: 'lead.created', created_at: '2026-08-20T09:20:01Z' };
	const rawBody = Buffer.from(JSON.stringify(payload));

	it('accepts a correctly signed delivery and starts the workflow', async () => {
		const header = signedHeader(Math.floor(Date.now() / 1000), rawBody, secret);
		const { context } = fakeWebhookContext({ webhookSecret: secret, signatureHeader: header, rawBody, bodyData: payload });

		const result = await webhook.call(context);

		expect(result).toEqual({ workflowData: [[{ json: payload }]] });
	});

	it('rejects with 401 and does not start the workflow when the signature is invalid', async () => {
		const header = `t=${Math.floor(Date.now() / 1000)},v1=0000000000000000000000000000000000000000000000000000000000000000`;
		const { context, statusMock, sendMock, endMock } = fakeWebhookContext({
			webhookSecret: secret,
			signatureHeader: header,
			rawBody,
			bodyData: payload,
		});

		const result = await webhook.call(context);

		expect(result).toEqual({ noWebhookResponse: true });
		expect(statusMock).toHaveBeenCalledWith(401);
		expect(sendMock).toHaveBeenCalledWith('Unauthorized');
		expect(endMock).toHaveBeenCalled();
	});

	it('rejects with 401 when the timestamp is outside the 5-minute anti-replay window (contrat §5)', async () => {
		const staleTimestamp = Math.floor(Date.now() / 1000) - 400;
		const header = signedHeader(staleTimestamp, rawBody, secret);
		const { context, statusMock } = fakeWebhookContext({ webhookSecret: secret, signatureHeader: header, rawBody, bodyData: payload });

		const result = await webhook.call(context);

		expect(result).toEqual({ noWebhookResponse: true });
		expect(statusMock).toHaveBeenCalledWith(401);
	});

	it('rejects with 401 when no secret has been stored yet', async () => {
		const header = signedHeader(Math.floor(Date.now() / 1000), rawBody, secret);
		const { context, statusMock } = fakeWebhookContext({ signatureHeader: header, rawBody, bodyData: payload });

		const result = await webhook.call(context);

		expect(result).toEqual({ noWebhookResponse: true });
		expect(statusMock).toHaveBeenCalledWith(401);
	});
});
