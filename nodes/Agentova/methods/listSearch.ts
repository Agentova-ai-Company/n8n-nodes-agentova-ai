import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

interface Automation {
	id: string;
	name: string;
}

interface AutomationListResponse {
	data: Automation[];
	has_more: boolean;
	next_cursor: string | null;
}

// Le serveur plafonne `limit` à 100 par page ; on suit `next_cursor` tant que
// `has_more` est vrai pour que le sélecteur "From list" voie tout le
// workspace, pas seulement les 100 premières automatisations. Le plafond de
// pages est un filet de sécurité, pas une limite attendue en usage normal.
const MAX_PAGES = 20;

export async function searchAutomations(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

	const automations: Automation[] = [];
	let cursor: string | null = null;

	for (let page = 0; page < MAX_PAGES; page++) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
			method: 'GET',
			baseURL: baseUrl,
			url: '/automations',
			qs: { limit: 100, ...(cursor ? { cursor } : {}) },
			json: true,
		})) as AutomationListResponse;

		automations.push(...response.data);

		if (!response.has_more || !response.next_cursor) break;
		cursor = response.next_cursor;
	}

	const filtered = filter
		? automations.filter((automation) => automation.name.toLowerCase().includes(filter.toLowerCase()))
		: automations;

	return {
		results: filtered.map((automation) => ({
			name: automation.name,
			value: automation.id,
		})),
	};
}
