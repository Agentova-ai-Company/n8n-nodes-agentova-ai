import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationPause = {
	operation: ['pause'],
	resource: ['automation'],
};

export const automationPauseDescription: INodeProperties[] = [
	{
		displayName: 'Automation',
		name: 'automationId',
		type: 'resourceLocator',
		required: true,
		displayOptions: { show: showOnlyForAutomationPause },
		default: { mode: 'list', value: '' },
		description: 'The automation to pause',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchAutomations', searchable: true },
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. aut_c29jaWFsOjNmYTg1ZjY0…',
			},
		],
	},
];
