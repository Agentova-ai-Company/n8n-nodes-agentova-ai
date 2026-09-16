import type { INodeProperties } from 'n8n-workflow';

const showOnlyForAutomationGet = {
	operation: ['get'],
	resource: ['automation'],
};

export const automationGetDescription: INodeProperties[] = [
	{
		displayName: 'Automation',
		name: 'automationId',
		type: 'resourceLocator',
		required: true,
		displayOptions: { show: showOnlyForAutomationGet },
		default: { mode: 'list', value: '' },
		description: 'The automation to retrieve',
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
