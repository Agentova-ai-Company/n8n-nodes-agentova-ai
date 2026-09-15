import type {
	IHookFunctions,
	IWebhookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import { createHmac, timingSafeEqual } from 'crypto';

// Tolérance anti-rejeu du contrat (§4/§5) : une livraison dont `t` s'écarte de
// plus de 5 minutes de l'heure courante est rejetée, même signée correctement.
const SIGNATURE_TOLERANCE_SECONDS = 300;

function parseSignatureHeader(header: string): { timestamp: string; signature: string } | null {
	let timestamp: string | undefined;
	let signature: string | undefined;
	for (const part of header.split(',')) {
		const [key, value] = part.trim().split('=');
		if (key === 't') timestamp = value;
		if (key === 'v1') signature = value;
	}
	if (!timestamp || !signature) return null;
	return { timestamp, signature };
}

// Patron du trigger Stripe officiel de n8n (StripeTriggerHelpers.ts) : HMAC sur
// le corps BRUT (pas le corps re-sérialisé par getBodyData), comparaison en
// temps constant pour ne pas fuiter la signature via le timing.
function isSignatureValid(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
	if (!rawBody || !header) return false;

	const parsed = parseSignatureHeader(header);
	if (!parsed) return false;

	const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parsed.timestamp));
	if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

	const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${rawBody.toString()}`).digest('hex');
	const expectedBuffer = Buffer.from(expected);
	const actualBuffer = Buffer.from(parsed.signature);

	return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export class AgentovaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agentova Trigger',
		name: 'agentovaTrigger',
		icon: { light: 'file:agentova.svg', dark: 'file:agentova.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when an Agentova workspace event occurs',
		defaults: {
			name: 'Agentova Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'agentovaApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				options: [
					{
						name: 'Automation Status Changed',
						value: 'automation.status_changed',
						description: 'An automation was activated or paused',
					},
					{
						name: 'Lead Created',
						value: 'lead.created',
						description: 'A new lead was captured, from any source',
					},
					{
						name: 'Run Completed',
						value: 'run.completed',
						description: 'An automation run finished — success, partial, or failed',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (webhookData.webhookId === undefined) return false;

				const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

				let response: { data: Array<{ id: string; disabled_at: string | null }> };
				try {
					response = (await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
						method: 'GET',
						baseURL: baseUrl,
						url: '/webhooks',
						json: true,
					})) as { data: Array<{ id: string; disabled_at: string | null }> };
				} catch (error) {
					// Route pas encore servie par l'API réelle (§ Disponibilité,
					// route_not_found) : on tolère ce cas en gardant le comportement
					// actuel plutôt que de recréer un abonnement à chaque activation.
					const statusCode = (error as { httpCode?: string; statusCode?: number }).statusCode;
					const httpCode = (error as { httpCode?: string }).httpCode;
					if (statusCode === 404 || httpCode === '404') return true;
					throw new NodeApiError(this.getNode(), error as JsonObject);
				}

				// Après des échecs de livraison prolongés, l'API désactive l'abonnement
				// (contrat §5) sans événement dédié — le seul signal est `disabled_at`
				// posé sur GET /webhooks. Un abonnement absent ou désactivé doit être
				// oublié pour que n8n en recrée un neuf, sinon le nœud reste silencieux.
				const webhook = response.data.find((w) => w.id === webhookData.webhookId);
				if (!webhook || webhook.disabled_at !== null) {
					delete webhookData.webhookId;
					delete webhookData.webhookSecret;
					return false;
				}

				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const events = this.getNodeParameter('events') as string[];
				const webhookData = this.getWorkflowStaticData('node');

				const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
					method: 'POST',
					baseURL: baseUrl,
					url: '/webhooks',
					body: { url: webhookUrl, events },
					json: true,
				})) as { id?: string; secret?: string };

				// Sans id ou secret, on stockerait `undefined` : checkExists répondrait
				// false et un abonnement serait recréé à chaque activation.
				if (!response.id || !response.secret) {
					throw new NodeApiError(this.getNode(), response as JsonObject, {
						message: 'Agentova did not return an id and secret for the new webhook subscription',
					});
				}

				webhookData.webhookId = response.id;
				webhookData.webhookSecret = response.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (webhookData.webhookId === undefined) return true;

				const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

				try {
					await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
						method: 'DELETE',
						baseURL: baseUrl,
						url: `/webhooks/${webhookData.webhookId}`,
						json: true,
					});
				} catch (error) {
					// Un webhook déjà supprimé répond 404 (contrat §4) — on ne bloque pas
					// la désactivation du workflow pour un abonnement qui n'existe déjà plus.
					const statusCode = (error as { httpCode?: string; statusCode?: number }).statusCode;
					const httpCode = (error as { httpCode?: string }).httpCode;
					if (statusCode !== 404 && httpCode !== '404') {
						throw new NodeApiError(this.getNode(), error as JsonObject);
					}
				}

				delete webhookData.webhookId;
				delete webhookData.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const webhookData = this.getWorkflowStaticData('node');
		const secret = webhookData.webhookSecret as string | undefined;

		const headerValue = this.getHeaderData()['x-agentova-signature'];
		const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
		const rawBody = this.getRequestObject().rawBody;

		if (!secret || !isSignatureValid(rawBody, header, secret)) {
			this.getResponseObject().status(401).send('Unauthorized').end();
			return { noWebhookResponse: true };
		}

		const body = this.getBodyData();

		return {
			workflowData: [[{ json: body }]],
		};
	}
}
