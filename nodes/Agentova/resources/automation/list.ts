import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationList = {
	operation: ['list'],
	resource: ['automation'],
};

export const automationListDescription: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: { show: showOnlyForAutomationList },
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		routing: {
			send: {
				paginate: '={{ $value }}',
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
			maxValue: 100,
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
