import { NodeConnectionTypes, type INodeType, type INodeTypeDescription } from 'n8n-workflow';
import { automationDescription } from './resources/automation';
import { searchAutomations } from './methods/listSearch';

export class Agentova implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agentova',
		name: 'agentova',
		icon: { light: 'file:agentova.svg', dark: 'file:agentova.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with the Agentova API',
		defaults: {
			name: 'Agentova',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'agentovaApi', required: true }],
		requestDefaults: {
			baseURL: 'https://api.agentova.ai/v1',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Automation',
						value: 'automation',
					},
				],
				default: 'automation',
			},
			...automationDescription,
		],
	};

	methods = {
		listSearch: {
			searchAutomations,
		},
	};
}
