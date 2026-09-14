import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationPause = {
	operation: ['pause'],
	resource: ['automation'],
};

export const automationPauseDescription: INodeProperties[] = [
	{
		displayName: 'Automation ID',
		name: 'automationId',
		type: 'string',
		required: true,
		displayOptions: { show: showOnlyForAutomationPause },
		default: '',
		description: 'The ID of the automation to pause',
	},
];
