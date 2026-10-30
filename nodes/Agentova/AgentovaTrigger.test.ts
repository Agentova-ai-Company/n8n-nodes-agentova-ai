import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	IDataObject,
	IHookFunctions,
	IHttpRequestOptions,
	IWebhookFunctions,
} from 'n8n-workflow';
import { createHmac } from 'crypto';
import {
	AgentovaTrigger,
	_processDeduplicationSize,
	_resetProcessDeduplication,
} from './AgentovaTrigger.node';

const WEBHOOK_URL = 'https://n8n.example.com/webhook/abc/webhook';

// Forme RÉELLE d'une erreur HTTP dans n8n (mesurée) : une AxiosError qui porte
// `status` et `response`, sans `statusCode` ni `httpCode`.
function apiError(status: number, code?: string, details: Record<string, unknown> = {}) {
	return {
		isAxiosError: true,
		status,
		message: `Request failed with status code ${status}`,
		response: {
			status,
			headers: {},
			data: code ? { error: { code, message: 'x', details } } : '<html>Not Found</html>',
		},
	};
}

function subscription(
	overrides: Partial<{
		id: string;
		url: string;
		events: string[];
		disabled_at: string | null;
	}> = {},
) {
	return {
		id: 'whk_123',
		url: WEBHOOK_URL,
		events: ['lead.created'],
		created_at: '2026-09-01T00:00:00Z',
		disabled_at: null,
		...overrides,
	};
}

interface FakeRequest {
	method: string;
	url: string;
	body?: unknown;
}

/**
 * API Agentova simulée pour le cycle de vie des abonnements : GET /webhooks rend
 * `list`, POST /webhooks rend `create`, DELETE /webhooks/{id} appelle `remove`.
 * Une route peut rendre `Promise.reject(apiError(...))`.
 */
function fakeApi(
	routes: { list?: () => unknown; create?: () => unknown; remove?: (id: string) => unknown } = {},
) {
	return (request: FakeRequest): unknown => {
		if (request.method === 'GET' && request.url === '/webhooks')
			return routes.list ? routes.list() : { data: [] };
		if (request.method === 'POST' && request.url === '/webhooks') {
			return routes.create ? routes.create() : { id: 'whk_new', secret: 'whsec_new' };
		}
		if (request.method === 'DELETE')
			return routes.remove ? routes.remove(request.url.replace('/webhooks/', '')) : undefined;
		return Promise.reject(new Error(`unexpected request ${request.method} ${request.url}`));
	};
}

function fakeHookContext(
	options: {
		webhookId?: string;
		webhookSecret?: string;
		events?: string[];
		webhookUrl?: string;
		api?: (request: FakeRequest) => unknown;
	} = {},
) {
	const staticData: IDataObject = {};
	if (options.webhookId) staticData.webhookId = options.webhookId;
	if (options.webhookSecret) staticData.webhookSecret = options.webhookSecret;

	const calls: string[] = [];
	const bodies: unknown[] = [];
	const api = options.api ?? fakeApi();
	const httpRequestWithAuthentication = vi.fn(
		async (_credentialType: string, request: IHttpRequestOptions) => {
			const method = request.method ?? 'GET';
			calls.push(`${method} ${request.url}`);
			if (request.body !== undefined) bodies.push(request.body);
			return await api({ method, url: request.url, body: request.body });
		},
	);
	const logger = { warn: vi.fn() };

	const context = {
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => options.webhookUrl ?? WEBHOOK_URL,
		getNodeParameter: () => options.events ?? ['lead.created'],
		getCredentials: vi.fn().mockResolvedValue({ baseUrl: 'https://api.agentova.test/v1' }),
		getNode: () => ({ id: 'node_1', name: 'Agentova Trigger' }),
		logger,
		helpers: { httpRequestWithAuthentication },
	} as unknown as IHookFunctions;

	return { context, staticData, calls, bodies, logger };
}

describe('AgentovaTrigger webhookMethods', () => {
	const { webhookMethods } = new AgentovaTrigger();

	describe('checkExists', () => {
		it('returns false without calling Agentova when no subscription is stored', async () => {
			const { context, calls } = fakeHookContext();

			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(calls).toEqual([]);
		});

		it('keeps a subscription that is enabled and still matches the URL and the events (no duplicate on restart)', async () => {
			const { context, calls } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
				api: fakeApi({ list: () => ({ data: [subscription()] }) }),
			});

			expect(await webhookMethods.default.checkExists.call(context)).toBe(true);
			expect(calls).toEqual(['GET /webhooks']);
		});

		it('compares the events as a set: another order is the same subscription', async () => {
			const { context } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
				events: ['run.completed', 'lead.created'],
				api: fakeApi({
					list: () => ({ data: [subscription({ events: ['lead.created', 'run.completed'] })] }),
				}),
			});

			expect(await webhookMethods.default.checkExists.call(context)).toBe(true);
		});

		it('forgets a subscription that no longer exists, without deleting anything', async () => {
			const { context, staticData, calls } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
			});

			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(calls).toEqual(['GET /webhooks']);
			expect(staticData.webhookId).toBeUndefined();
			expect(staticData.webhookSecret).toBeUndefined();
		});

		it.each([
			[
				'disabled by Agentova after failed deliveries',
				{ disabled_at: '2026-09-01T00:00:00Z' },
				undefined,
				'disabled_by_agentova',
			],
			[
				"n8n's webhook URL changed",
				{ url: 'https://old-tunnel.example.com/webhook/abc/webhook' },
				undefined,
				'webhook_url_changed',
			],
			[
				"n8n's webhook endpoint prefix changed",
				{ url: 'https://n8n.example.com/hooks/abc/webhook' },
				undefined,
				'webhook_url_changed',
			],
			['the selected events changed', {}, ['lead.created', 'run.completed'], 'events_changed'],
		])(
			'deletes a stale subscription (%s) and forgets it, so that n8n creates a new one',
			async (_label, stored, events, reason) => {
				const { context, staticData, calls, logger } = fakeHookContext({
					webhookId: 'whk_123',
					webhookSecret: 'whsec_test123',
					events,
					api: fakeApi({ list: () => ({ data: [subscription(stored)] }) }),
				});

				expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
				expect(calls).toEqual(['GET /webhooks', 'DELETE /webhooks/whk_123']);
				expect(staticData.webhookId).toBeUndefined();
				expect(staticData.webhookSecret).toBeUndefined();
				expect(logger.warn).toHaveBeenCalledWith(
					'Agentova Trigger: replacing a stale webhook subscription',
					{ reason },
				);
			},
		);

		it('forgets, WITHOUT deleting, a subscription inherited from a duplicated workflow (another node URL)', async () => {
			// Avant n8n 2.36, la copie d'un workflow hérite des données statiques de
			// l'original (abonnement + secret) avec un nouveau `webhookId` de nœud.
			// Supprimer cet abonnement couperait l'original, toujours actif.
			const { context, staticData, calls, logger } = fakeHookContext({
				webhookId: 'whk_original',
				webhookSecret: 'whsec_original',
				webhookUrl: 'https://n8n.example.com/webhook/copy-node/webhook',
				api: fakeApi({
					list: () => ({
						data: [
							subscription({
								id: 'whk_original',
								url: 'https://n8n.example.com/webhook/original-node/webhook',
							}),
						],
					}),
				}),
			});

			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(calls).toEqual(['GET /webhooks']);
			expect(staticData.webhookId).toBeUndefined();
			expect(staticData.webhookSecret).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(
				'Agentova Trigger: ignoring a webhook subscription of another node',
				{ reason: 'inherited_from_another_node' },
			);
		});

		it('replaces a subscription whose secret was lost: none of its deliveries could be verified', async () => {
			const { context, calls } = fakeHookContext({
				webhookId: 'whk_123',
				api: fakeApi({ list: () => ({ data: [subscription()] }) }),
			});

			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(calls).toEqual(['GET /webhooks', 'DELETE /webhooks/whk_123']);
		});

		it('still forgets a stale subscription that Agentova already deleted (webhook_not_found)', async () => {
			const { context, staticData } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
				api: fakeApi({
					list: () => ({ data: [subscription({ disabled_at: '2026-09-01T00:00:00Z' })] }),
					remove: () => Promise.reject(apiError(404, 'webhook_not_found')),
				}),
			});

			expect(await webhookMethods.default.checkExists.call(context)).toBe(false);
			expect(staticData.webhookId).toBeUndefined();
		});

		it('fails the activation and keeps the id when the stale subscription cannot be deleted', async () => {
			const { context, staticData } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
				api: fakeApi({
					list: () => ({
						data: [subscription({ url: 'https://old-tunnel.example.com/webhook/abc/webhook' })],
					}),
					remove: () => Promise.reject(apiError(500, 'internal_error')),
				}),
			});

			await expect(webhookMethods.default.checkExists.call(context)).rejects.toThrow(
				'Agentova internal error',
			);
			expect(staticData.webhookId).toBe('whk_123');
		});

		it('no longer tolerates route_not_found: the error surfaces, in English', async () => {
			const { context, staticData } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
				api: fakeApi({ list: () => Promise.reject(apiError(404, 'route_not_found')) }),
			});

			await expect(webhookMethods.default.checkExists.call(context)).rejects.toThrow(
				'Agentova API route not found',
			);
			expect(staticData.webhookId).toBe('whk_123');
		});

		it('reports any OTHER 404 (wrong base URL, proxy…) instead of pretending the subscription exists', async () => {
			const { context } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
				api: fakeApi({ list: () => Promise.reject(apiError(404)) }),
			});

			await expect(webhookMethods.default.checkExists.call(context)).rejects.toThrow();
		});
	});

	describe('create', () => {
		it('subscribes with the node webhook URL and the selected events, stores the returned id and secret', async () => {
			const { context, staticData, calls, bodies } = fakeHookContext({
				events: ['lead.created', 'run.completed'],
				api: fakeApi({ create: () => ({ id: 'whk_123', secret: 'whsec_test123' }) }),
			});

			expect(await webhookMethods.default.create.call(context)).toBe(true);
			expect(calls).toEqual(['GET /webhooks', 'POST /webhooks']);
			expect(bodies).toEqual([{ url: WEBHOOK_URL, events: ['lead.created', 'run.completed'] }]);
			expect(staticData.webhookId).toBe('whk_123');
			expect(staticData.webhookSecret).toBe('whsec_test123');
		});

		it('deletes every leftover subscription pointing at this node URL before creating the new one', async () => {
			const { context, calls, logger } = fakeHookContext({
				api: fakeApi({
					list: () => ({
						data: [
							subscription({ id: 'whk_orphan_1' }),
							subscription({ id: 'whk_orphan_2', disabled_at: '2026-09-01T00:00:00Z' }),
							subscription({ id: 'whk_zapier', url: 'https://hooks.zapier.com/hooks/standard/1/' }),
						],
					}),
				}),
			});

			expect(await webhookMethods.default.create.call(context)).toBe(true);
			expect(calls).toEqual([
				'GET /webhooks',
				'DELETE /webhooks/whk_orphan_1',
				'DELETE /webhooks/whk_orphan_2',
				'POST /webhooks',
			]);
			expect(logger.warn).toHaveBeenCalledWith(
				'Agentova Trigger: deleted leftover webhook subscriptions for this node',
				{
					count: 2,
				},
			);
		});

		it('ignores a leftover subscription deleted in the meantime (webhook_not_found)', async () => {
			const { context, staticData } = fakeHookContext({
				api: fakeApi({
					list: () => ({ data: [subscription({ id: 'whk_orphan_1' })] }),
					remove: () => Promise.reject(apiError(404, 'webhook_not_found')),
				}),
			});

			expect(await webhookMethods.default.create.call(context)).toBe(true);
			expect(staticData.webhookId).toBe('whk_new');
		});

		it('creates nothing when a leftover subscription cannot be deleted', async () => {
			const { context, calls, staticData } = fakeHookContext({
				api: fakeApi({
					list: () => ({ data: [subscription({ id: 'whk_orphan_1' })] }),
					remove: () => Promise.reject(apiError(500, 'internal_error')),
				}),
			});

			await expect(webhookMethods.default.create.call(context)).rejects.toThrow(
				'Agentova internal error',
			);
			expect(calls).not.toContain('POST /webhooks');
			expect(staticData.webhookId).toBeUndefined();
		});

		it('explains in English why Agentova refused the webhook URL', async () => {
			const { context } = fakeHookContext({
				webhookUrl: 'http://localhost:5678/webhook/abc/webhook',
				api: fakeApi({
					create: () =>
						Promise.reject(
							apiError(400, 'invalid_request', { parameter: 'url', reason: 'https_required' }),
						),
				}),
			});

			const error = await webhookMethods.default.create
				.call(context)
				.catch((e: Error & { description?: string }) => e);
			expect(error).toMatchObject({ message: 'Agentova rejected the request as invalid' });
			expect((error as { description?: string }).description).toMatch(/HTTPS/);
		});

		it('throws NodeApiError when the response is missing id or secret', async () => {
			const { context } = fakeHookContext({ api: fakeApi({ create: () => ({ id: 'whk_123' }) }) });

			await expect(webhookMethods.default.create.call(context)).rejects.toThrow(/id and secret/);
		});
	});

	describe('delete', () => {
		it('unsubscribes using the stored id and clears static data', async () => {
			const { context, staticData, calls } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_test123',
			});

			expect(await webhookMethods.default.delete.call(context)).toBe(true);
			expect(calls).toEqual(['DELETE /webhooks/whk_123']);
			expect(staticData.webhookId).toBeUndefined();
			expect(staticData.webhookSecret).toBeUndefined();
		});

		it('is a no-op when no webhook was ever created', async () => {
			const { context, calls } = fakeHookContext();

			expect(await webhookMethods.default.delete.call(context)).toBe(true);
			expect(calls).toEqual([]);
		});

		it('treats webhook_not_found (already deleted) as success and forgets the subscription (contract §4)', async () => {
			const { context, staticData } = fakeHookContext({
				webhookId: 'whk_123',
				webhookSecret: 'whsec_x',
				api: fakeApi({ remove: () => Promise.reject(apiError(404, 'webhook_not_found')) }),
			});

			expect(await webhookMethods.default.delete.call(context)).toBe(true);
			expect(staticData.webhookId).toBeUndefined();
			expect(staticData.webhookSecret).toBeUndefined();
		});

		it('no longer tolerates route_not_found: reports it and keeps the subscription id', async () => {
			const { context, staticData } = fakeHookContext({
				webhookId: 'whk_123',
				api: fakeApi({ remove: () => Promise.reject(apiError(404, 'route_not_found')) }),
			});

			await expect(webhookMethods.default.delete.call(context)).rejects.toThrow(
				'Agentova API route not found',
			);
			expect(staticData.webhookId).toBe('whk_123');
		});

		it('reports an unrelated 404 and keeps the subscription id', async () => {
			const { context, staticData } = fakeHookContext({
				webhookId: 'whk_123',
				api: fakeApi({ remove: () => Promise.reject(apiError(404)) }),
			});

			await expect(webhookMethods.default.delete.call(context)).rejects.toThrow();
			expect(staticData.webhookId).toBe('whk_123');
		});

		it('wraps any other error in an English NodeApiError', async () => {
			const { context } = fakeHookContext({
				webhookId: 'whk_123',
				api: fakeApi({ remove: () => Promise.reject(apiError(401, 'invalid_api_key')) }),
			});

			await expect(webhookMethods.default.delete.call(context)).rejects.toThrow(
				'Invalid or revoked Agentova API key',
			);
		});
	});
});

describe('AgentovaTrigger create — id-only response', () => {
	const { webhookMethods } = new AgentovaTrigger();

	it('deletes the subscription created without a secret before failing, and stores nothing', async () => {
		const { context, staticData, calls } = fakeHookContext({
			api: fakeApi({ create: () => ({ id: 'whk_orphan' }) }),
		});

		await expect(webhookMethods.default.create.call(context)).rejects.toThrow();
		expect(calls).toEqual(['GET /webhooks', 'POST /webhooks', 'DELETE /webhooks/whk_orphan']);
		expect(staticData.webhookId).toBeUndefined();
	});

	it('still reports the creation failure when the cleanup itself fails', async () => {
		const { context, logger } = fakeHookContext({
			api: fakeApi({
				create: () => ({ id: 'whk_orphan' }),
				remove: () => Promise.reject(apiError(500)),
			}),
		});

		await expect(webhookMethods.default.create.call(context)).rejects.toThrow(/id and secret/);
		expect(logger.warn).toHaveBeenCalledWith(
			'Agentova: could not delete the webhook subscription created without a secret',
			{ webhookId: 'whk_orphan', status: 500 },
		);
	});
});

function signedHeader(timestamp: number, rawBody: Buffer, secret: string): string {
	const signature = createHmac('sha256', secret)
		.update(`${timestamp}.${rawBody.toString()}`)
		.digest('hex');
	return `t=${timestamp},v1=${signature}`;
}

function fakeWebhookContext(options: {
	webhookSecret?: string;
	signatureHeader?: string;
	rawBody?: Buffer;
	bodyData?: Record<string, unknown>;
	workflowId?: string;
	nodeId?: string;
	staticData?: IDataObject;
}) {
	const staticData: IDataObject = options.staticData ?? {};
	if (options.webhookSecret) staticData.webhookSecret = options.webhookSecret;

	const statusMock = vi.fn().mockReturnThis();
	const sendMock = vi.fn().mockReturnThis();
	const endMock = vi.fn();
	const logger = { warn: vi.fn() };

	const context = {
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: options.workflowId ?? 'wf_1' }),
		getNode: () => ({ id: options.nodeId ?? 'node_1', name: 'Agentova Trigger' }),
		logger,
		getHeaderData: () =>
			options.signatureHeader ? { 'x-agentova-signature': options.signatureHeader } : {},
		getRequestObject: () => ({ rawBody: options.rawBody }),
		getResponseObject: () => ({ status: statusMock, send: sendMock, end: endMock }),
		getBodyData: () => options.bodyData ?? {},
	} as unknown as IWebhookFunctions;

	return { context, staticData, statusMock, sendMock, endMock, logger };
}

describe('AgentovaTrigger webhook (event delivery)', () => {
	const { webhook } = new AgentovaTrigger();
	const secret = 'whsec_test123';
	const payload = {
		id: 'evt_01HZX7B2C3D4E5F6G7H8J9K0L1',
		type: 'lead.created',
		created_at: '2026-08-20T09:20:01Z',
	};
	const rawBody = Buffer.from(JSON.stringify(payload));
	const now = () => Math.floor(Date.now() / 1000);

	/** Une livraison correctement signée, avec des données statiques neuves (n8n ne les enregistre pas). */
	function delivery(
		overrides: { workflowId?: string; nodeId?: string; body?: Record<string, unknown> } = {},
	) {
		const body = overrides.body ?? payload;
		const raw = Buffer.from(JSON.stringify(body));
		return fakeWebhookContext({
			webhookSecret: secret,
			signatureHeader: signedHeader(now(), raw, secret),
			rawBody: raw,
			bodyData: body,
			workflowId: overrides.workflowId,
			nodeId: overrides.nodeId,
		});
	}

	beforeEach(() => {
		_resetProcessDeduplication();
	});

	it('accepts a correctly signed delivery and starts the workflow, without logging anything', async () => {
		const { context, logger } = delivery();

		expect(await webhook.call(context)).toEqual({ workflowData: [[{ json: payload }]] });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('acknowledges a replayed delivery (same evt id, same node, fresh signature) WITHOUT starting the workflow again (contract §5)', async () => {
		expect(await webhook.call(delivery().context)).toEqual({ workflowData: [[{ json: payload }]] });

		// Nouvelle tentative re-signée. Données statiques VIDES, comme dans n8n réel
		// (elles ne sont pas enregistrées pendant webhook()) : seule la mémoire de
		// processus peut reconnaître l'événement.
		const replay = delivery();
		expect(await webhook.call(replay.context)).toEqual({ noWebhookResponse: true });
		expect(replay.statusMock).toHaveBeenCalledWith(200);
	});

	it('runs each of two Agentova Triggers of the same workflow once for the same event', async () => {
		// Agentova envoie le même `evt_` à chacun de ses abonnements : un par nœud.
		for (const nodeId of ['node_A', 'node_B']) {
			expect(await webhook.call(delivery({ nodeId }).context)).toEqual({
				workflowData: [[{ json: payload }]],
			});
		}
		for (const nodeId of ['node_A', 'node_B']) {
			expect(await webhook.call(delivery({ nodeId }).context)).toEqual({ noWebhookResponse: true });
		}
	});

	it('does not confuse the same event id delivered to two different workflows', async () => {
		for (const workflowId of ['wf_A', 'wf_B']) {
			expect(await webhook.call(delivery({ workflowId }).context)).toEqual({
				workflowData: [[{ json: payload }]],
			});
		}
	});

	it('starts the workflow for two DIFFERENT events', async () => {
		const staticData: IDataObject = {};
		for (const id of ['evt_A', 'evt_B']) {
			const body = { ...payload, id };
			const raw = Buffer.from(JSON.stringify(body));
			const { context } = fakeWebhookContext({
				webhookSecret: secret,
				signatureHeader: signedHeader(now(), raw, secret),
				rawBody: raw,
				bodyData: body,
				staticData,
			});
			expect(await webhook.call(context)).toEqual({ workflowData: [[{ json: body }]] });
		}
	});

	it('keeps the deduplication memory bounded', async () => {
		const staticData: IDataObject = {};
		for (let i = 0; i < 520; i++) {
			const body = { ...payload, id: `evt_${i}` };
			const raw = Buffer.from(JSON.stringify(body));
			const { context } = fakeWebhookContext({
				webhookSecret: secret,
				signatureHeader: signedHeader(now(), raw, secret),
				rawBody: raw,
				bodyData: body,
				staticData,
			});
			await webhook.call(context);
		}
		expect((staticData.seenEvents as unknown[]).length).toBe(500);
	});

	it('still recognizes a replay after thousands of OTHER events (the memory is bounded by age first)', async () => {
		expect(await webhook.call(delivery().context)).toEqual({ workflowData: [[{ json: payload }]] });
		for (let i = 0; i < 6000; i++) {
			await webhook.call(delivery({ body: { ...payload, id: `evt_other_${i}` } }).context);
		}

		expect(await webhook.call(delivery().context)).toEqual({ noWebhookResponse: true });
	});

	it('remembers an event for 72 hours, then forgets it', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
			expect(await webhook.call(delivery().context)).toEqual({
				workflowData: [[{ json: payload }]],
			});

			vi.setSystemTime(new Date('2026-10-04T09:59:00Z'));
			expect(await webhook.call(delivery().context)).toEqual({ noWebhookResponse: true });

			// Une autre livraison, 72 h et 1 min après la première : le ménage par âge
			// retire l'événement, dont la nouvelle tentative relance le workflow.
			vi.setSystemTime(new Date('2026-10-04T10:01:00Z'));
			await webhook.call(delivery({ body: { ...payload, id: 'evt_later' } }).context);
			expect(await webhook.call(delivery().context)).toEqual({
				workflowData: [[{ json: payload }]],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('frees the memory of expired events as new ones arrive', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
			for (const id of ['evt_1', 'evt_2', 'evt_3']) {
				await webhook.call(delivery({ body: { ...payload, id } }).context);
			}
			expect(_processDeduplicationSize()).toBe(3);

			vi.setSystemTime(new Date('2026-10-04T11:00:00Z'));
			await webhook.call(delivery({ body: { ...payload, id: 'evt_4' } }).context);
			expect(_processDeduplicationSize()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not remember an event whose signature was rejected', async () => {
		const { context, staticData } = fakeWebhookContext({
			webhookSecret: secret,
			signatureHeader: `t=${now()},v1=00`,
			rawBody,
			bodyData: payload,
		});

		await webhook.call(context);
		expect(staticData.seenEvents).toBeUndefined();
	});

	it('rejects a forged signature with 401, never starts the workflow, and logs the reason only', async () => {
		const forged = '0'.repeat(64);
		const { context, statusMock, sendMock, endMock, logger } = fakeWebhookContext({
			webhookSecret: secret,
			signatureHeader: `t=${now()},v1=${forged}`,
			rawBody,
			bodyData: payload,
		});

		expect(await webhook.call(context)).toEqual({ noWebhookResponse: true });
		expect(statusMock).toHaveBeenCalledWith(401);
		expect(sendMock).toHaveBeenCalledWith('Unauthorized');
		expect(endMock).toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith('Agentova Trigger: rejected a webhook delivery', {
			reason: 'signature_mismatch',
			workflowId: 'wf_1',
			node: 'Agentova Trigger',
		});
		// Ni le secret, ni la signature reçue, ni l'attendue, ni le corps.
		const logged = JSON.stringify(logger.warn.mock.calls);
		const expected = createHmac('sha256', secret)
			.update(`${now()}.${rawBody.toString()}`)
			.digest('hex');
		for (const sensitive of [secret, forged, expected, payload.id]) {
			expect(logged).not.toContain(sensitive);
		}
	});

	it.each([
		['the timestamp is outside the 5-minute anti-replay window (contract §5)', 'stale_timestamp'],
		['no secret has been stored yet', 'no_secret'],
		['the signature header is missing', 'missing_signature'],
		['the signature header is malformed', 'malformed_signature'],
	])('rejects with 401 when %s, and logs why', async (_label, reason) => {
		const headers: Record<string, string | undefined> = {
			stale_timestamp: signedHeader(now() - 400, rawBody, secret),
			no_secret: signedHeader(now(), rawBody, secret),
			missing_signature: undefined,
			malformed_signature: 'v1=abc',
		};
		const { context, statusMock, logger } = fakeWebhookContext({
			webhookSecret: reason === 'no_secret' ? undefined : secret,
			signatureHeader: headers[reason],
			rawBody,
			bodyData: payload,
		});

		expect(await webhook.call(context)).toEqual({ noWebhookResponse: true });
		expect(statusMock).toHaveBeenCalledWith(401);
		expect(logger.warn).toHaveBeenCalledWith(
			'Agentova Trigger: rejected a webhook delivery',
			expect.objectContaining({ reason }),
		);
	});
});
