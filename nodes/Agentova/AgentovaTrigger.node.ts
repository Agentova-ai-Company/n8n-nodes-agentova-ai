import type {
	IHookFunctions,
	IWebhookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';

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
				return webhookData.webhookId !== undefined;
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
				})) as { id: string };

				webhookData.webhookId = response.id;
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
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();

		return {
			workflowData: [[{ json: body }]],
		};
	}
}
