import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationGet = {
	operation: ['get'],
	resource: ['automation'],
};

export const automationGetDescription: INodeProperties[] = [
	{
		displayName: 'Automation ID',
		name: 'automationId',
		type: 'string',
		required: true,
		displayOptions: { show: showOnlyForAutomationGet },
		default: '',
		description: 'The ID of the automation to retrieve',
	},
];
