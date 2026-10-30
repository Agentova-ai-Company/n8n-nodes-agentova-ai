import type { INodeProperties } from 'n8n-workflow';
import { automationListDescription } from './list';
import { automationGetDescription } from './get';
import { automationActivateDescription } from './activate';
import { automationPauseDescription } from './pause';
import { CONTROL_STATUS, expectStatus, explainApiError } from '../../helpers/controlResponse';

const showOnlyForAutomations = {
	resource: ['automation'],
};

export const automationDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForAutomations,
		},
		options: [
			{
				name: 'List',
				value: 'list',
				action: 'List automations',
				description: 'List automations in the workspace',
				routing: {
					request: {
						method: 'GET',
						url: '/automations',
						ignoreHttpStatusErrors: true,
					},
					output: {
						postReceive: [
							explainApiError,
							{
								type: 'rootProperty',
								properties: {
									property: 'data',
								},
							},
						],
					},
				},
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get an automation',
				description: 'Get a single automation by ID',
				routing: {
					request: {
						method: 'GET',
						url: '=/automations/{{$parameter.automationId}}',
						ignoreHttpStatusErrors: true,
					},
					output: { postReceive: [explainApiError] },
				},
			},
			{
				name: 'Activate',
				value: 'activate',
				action: 'Activate an automation',
				description: 'Activate a paused automation',
				routing: {
					request: {
						method: 'PATCH',
						url: '=/automations/{{$parameter.automationId}}',
						body: {
							status: CONTROL_STATUS.ACTIVE,
						},
						ignoreHttpStatusErrors: true,
					},
					output: { postReceive: [expectStatus(CONTROL_STATUS.ACTIVE)] },
				},
			},
			{
				name: 'Pause',
				value: 'pause',
				action: 'Pause an automation',
				description: 'Pause an active automation',
				routing: {
					request: {
						method: 'PATCH',
						url: '=/automations/{{$parameter.automationId}}',
						body: {
							status: CONTROL_STATUS.PAUSED,
						},
						ignoreHttpStatusErrors: true,
					},
					output: { postReceive: [expectStatus(CONTROL_STATUS.PAUSED)] },
				},
			},
		],
		default: 'list',
	},
	...automationListDescription,
	...automationGetDescription,
	...automationActivateDescription,
	...automationPauseDescription,
];
