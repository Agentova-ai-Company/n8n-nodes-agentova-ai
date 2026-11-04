import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationList = {
	operation: ['list'],
	resource: ['automation'],
};

/** Plafond de `limit` au contrat (paramètre `Limit`, maximum 100). */
export const MAX_PAGE_SIZE = 100;

export const automationListDescription: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: { show: showOnlyForAutomationList },
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		routing: {
			// Pages pleines : sans `limit`, l'API sert 25 automatisations par page,
			// soit quatre fois plus de requêtes sur le quota de la clé. Return All
			// décoché, le champ Limit envoie aussi `limit` et son `maxResults` borne
			// la sortie quel que soit l'ordre de traitement (même patron que le
			// modèle officiel n8n GithubIssues : `per_page` à 100 sur Return All).
			send: {
				paginate: '={{ $value }}',
				type: 'query',
				property: 'limit',
				value: String(MAX_PAGE_SIZE),
			},
			operations: {
				pagination: {
					type: 'generic',
					properties: {
						continue: '={{ $response.body.has_more }}',
						request: {
							qs: {
								cursor: '={{ $response.body.next_cursor }}',
							},
						},
					},
				},
			},
		},
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		displayOptions: {
			show: {
				...showOnlyForAutomationList,
				returnAll: [false],
			},
		},
		typeOptions: {
			minValue: 1,
			maxValue: MAX_PAGE_SIZE,
		},
		default: 50,
		description: 'Max number of results to return',
		routing: {
			send: {
				type: 'query',
				property: 'limit',
			},
			output: {
				maxResults: '={{$value}}',
			},
		},
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showOnlyForAutomationList },
		options: [
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Active', value: 'active' },
					{ name: 'Paused', value: 'paused' },
					{ name: 'Draft', value: 'draft' },
					{ name: 'Error', value: 'error' },
				],
				default: 'active',
				routing: {
					send: {
						type: 'query',
						property: 'status',
					},
				},
			},
			{
				displayName: 'Type',
				name: 'type',
				type: 'options',
				options: [
					{ name: 'CRM Source', value: 'crm_source' },
					{ name: 'Email Messages', value: 'email_messages' },
					{ name: 'Lead Ads', value: 'lead_ads' },
					{ name: 'Social Comments', value: 'social_comments' },
					{ name: 'Social Messages', value: 'social_messages' },
					{ name: 'Social Story', value: 'social_story' },
				],
				default: 'social_comments',
				routing: {
					send: {
						type: 'query',
						property: 'type',
					},
				},
			},
			{
				displayName: 'Agent ID',
				name: 'agentId',
				type: 'string',
				default: '',
				routing: {
					send: {
						type: 'query',
						property: 'agent_id',
					},
				},
			},
		],
	},
];
