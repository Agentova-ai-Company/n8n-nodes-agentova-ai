import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationActivate = {
	operation: ['activate'],
	resource: ['automation'],
};

export const automationActivateDescription: INodeProperties[] = [
	{
		displayName: 'Automation',
		name: 'automationId',
		type: 'resourceLocator',
		required: true,
		displayOptions: { show: showOnlyForAutomationActivate },
		default: { mode: 'list', value: '' },
		description: 'The automation to activate',
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
				placeholder: 'e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6',
			},
		],
	},
];
