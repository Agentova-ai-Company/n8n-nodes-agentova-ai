import type {
	Icon,
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AgentovaApi implements ICredentialType {
	name = 'agentovaApi';

	displayName = 'Agentova API';

	icon: Icon = { light: 'file:../nodes/Agentova/agentova.svg', dark: 'file:../nodes/Agentova/agentova.dark.svg' };

	// Link to your community node's README
	documentationUrl = 'https://github.com/Agentova-ai-Company/n8n-nodes-agentova-ai#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.agentova.ai/v1',
			url: '/v1/user',
		},
	};
}
