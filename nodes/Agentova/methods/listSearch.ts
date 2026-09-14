import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

export async function searchAutomations(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
		method: 'GET',
		baseURL: 'https://api.agentova.ai/v1',
		url: '/automations',
		qs: { limit: 100 },
		json: true,
	})) as { data: Array<{ id: string; name: string }> };

	const automations = filter
		? response.data.filter((automation) => automation.name.toLowerCase().includes(filter.toLowerCase()))
		: response.data;

	return {
		results: automations.map((automation) => ({
			name: automation.name,
			value: automation.id,
		})),
	};
}
