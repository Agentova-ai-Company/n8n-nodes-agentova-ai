import { describe, expect, it, vi } from 'vitest';
import type { IHookFunctions } from 'n8n-workflow';
import { AgentovaTrigger } from './AgentovaTrigger.node';

function fakeContext(options: {
	webhookId?: string;
	events?: string[];
	httpImpl?: (...args: unknown[]) => unknown;
}) {
	const staticData: Record<string, unknown> = {};
	if (options.webhookId) staticData.webhookId = options.webhookId;

	const httpRequestWithAuthentication = vi.fn(options.httpImpl ?? (() => Promise.resolve({ id: 'wh_123' })));

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

		it('returns true when a webhook id is already stored (no duplicate on restart)', async () => {
			const { context } = fakeContext({ webhookId: 'wh_123' });
			expect(await webhookMethods.default.checkExists.call(context)).toBe(true);
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
		});
	});

	describe('delete', () => {
		it('unsubscribes using the stored id and clears static data', async () => {
			const { context, staticData, httpRequestWithAuthentication } = fakeContext({ webhookId: 'wh_123' });

			const result = await webhookMethods.default.delete.call(context);

			expect(result).toBe(true);
			expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
				'agentovaApi',
				expect.objectContaining({ method: 'DELETE', url: '/webhooks/wh_123' }),
			);
			expect(staticData.webhookId).toBeUndefined();
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
