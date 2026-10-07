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

	icon: Icon = {
		light: 'file:../nodes/Agentova/agentova.svg',
		dark: 'file:../nodes/Agentova/agentova.dark.svg',
	};

	documentationUrl = 'https://docs.agentova.ai/n8n/credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Your Agentova API key, starting with agk_live_. A workspace admin creates it in Agentova under Settings > API. One key gives access to one whole workspace.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: 'https://core-api.agentova.ai/v1',
			description:
				'Address of the Agentova API. Keep the default unless Agentova gives you another one.',
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

	// Sans règle, le testeur d'identifiants de n8n n'affiche que le libellé HTTP
	// (« Unauthorized », « Forbidden ») ou « Received HTTP status code: 404 »
	// (lu dans son code, n8n 2.39). Une règle par statut du contrat donne la
	// cause et le geste, dans les mots des erreurs du nœud.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/automations',
			qs: { limit: 1 },
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'Invalid or revoked Agentova API key. A workspace admin can create a new key in Agentova under Settings > API.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'This Agentova workspace has no access to the API. Check its subscription in the billing settings of Agentova.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message: 'No Agentova API at this Base URL. Restore the default Base URL.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 429,
					message: 'Agentova rate limit reached. Retry in a minute.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 500,
					message: 'Agentova internal error. Retry later.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 503,
					message: 'The Agentova API is temporarily unavailable. Retry later.',
				},
			},
		],
	};
}
