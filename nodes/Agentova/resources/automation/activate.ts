import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationActivate = {
	operation: ['activate'],
	resource: ['automation'],
};

export const automationActivateDescription: INodeProperties[] = [
	{
		displayName: 'Automation ID',
		name: 'automationId',
		type: 'string',
		required: true,
		displayOptions: { show: showOnlyForAutomationActivate },
		default: '',
		description: 'The ID of the automation to activate',
	},
];
