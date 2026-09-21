import type { IExecuteSingleFunctions, IN8nHttpFullResponse, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { AGENTOVA_ERROR } from './apiError';

// `PATCH /automations/{id}` est au contrat mais n'est PAS encore servi par l'API
// réelle (contrat, § Disponibilité) : elle répond `404 route_not_found`. Sans ce
// traitement, l'utilisateur d'Activate / Pause lit un « 404 Not Found » brut et
// cherche une faute de son côté — mauvais identifiant, mauvaise clé. On lui dit
// ce qui se passe vraiment. Toute autre erreur reste une NodeApiError ordinaire.
//
// Appelé en `postReceive` avec `ignoreHttpStatusErrors: true` sur la requête :
// c'est la seule façon, en style déclaratif, de voir le corps d'une réponse
// d'erreur avant que n8n ne la transforme.
export async function explainControlError(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode < 400) return items;

	const body = (typeof response.body === 'object' && response.body !== null ? response.body : {}) as JsonObject;
	const code = (body.error as { code?: unknown } | undefined)?.code;

	if (response.statusCode === 404 && code === AGENTOVA_ERROR.ROUTE_NOT_FOUND) {
		throw new NodeApiError(this.getNode(), body, {
			httpCode: '404',
			message: 'Activate and Pause are not available yet',
			description:
				'The Agentova API does not serve this operation yet (route_not_found). Your API key and automation ID are not at fault. List and Get are available today.',
		});
	}

	throw new NodeApiError(this.getNode(), body, { httpCode: String(response.statusCode) });
}
