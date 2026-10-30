import type {
	IDataObject,
	IExecuteSingleFunctions,
	IN8nHttpFullResponse,
	INode,
	INodeExecutionData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { agentovaErrorInBody, agentovaNodeApiError, parseRetryAfter } from './apiError';

// Réponses du routage déclaratif (List, Get, Activate, Pause).
//
// Les requêtes portent `ignoreHttpStatusErrors: true` : c'est la seule façon,
// en style déclaratif, de voir le corps et les en-têtes d'une réponse d'erreur
// avant que n8n ne la transforme. Sans cela, n8n affiche tel quel le message de
// l'API (changeant selon le contrat, et en français jusqu'au draft.6) et
// l'utilisateur d'un 429 ne voit jamais le `Retry-After`.

/** Statuts qu'Activate et Pause demandent à `PATCH /automations/{id}`. */
export const CONTROL_STATUS = {
	ACTIVE: 'active',
	PAUSED: 'paused',
} as const;

export type ControlStatus = (typeof CONTROL_STATUS)[keyof typeof CONTROL_STATUS];

const NOT_AGENTOVA_HINT =
	'The response did not come from the Agentova API. Check the Base URL of the Agentova credential (default: https://core-api.agentova.ai/v1).';

/** Le corps JSON d'une réponse en objet, ou `{}` (corps vide, texte, flux, tableau). */
function jsonBody(body: IN8nHttpFullResponse['body']): IDataObject {
	let value: unknown = body;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	const isObject =
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!Buffer.isBuffer(value) &&
		typeof (value as { pipe?: unknown }).pipe !== 'function';
	return isObject ? (value as IDataObject) : {};
}

function errorFromResponse(node: INode, response: IN8nHttpFullResponse): NodeApiError {
	const agentovaError = agentovaErrorInBody(response.body);
	if (agentovaError !== undefined) {
		const retryAfter = parseRetryAfter(response.headers?.['retry-after']);
		return agentovaNodeApiError(node, agentovaError, response.statusCode, retryAfter);
	}

	// Pas un corps Agentova : un proxy, ou une Base URL qui ne pointe pas sur l'API
	// (un 404 générique, sans `route_not_found`).
	return new NodeApiError(node, jsonBody(response.body) as JsonObject, {
		httpCode: String(response.statusCode),
		...(response.statusCode === 404 ? { description: NOT_AGENTOVA_HINT } : {}),
	});
}

function statusMismatchError(
	node: INode,
	requested: ControlStatus,
	obtained: string,
	body: IDataObject,
): NodeOperationError {
	const automation = typeof body.name === 'string' ? `Automation "${body.name}"` : 'The automation';

	// Cas prévu par le contrat : la reprise d'une source CRM échoue, l'API répond
	// 200 avec `status: error`.
	if (requested === CONTROL_STATUS.ACTIVE && obtained === 'error') {
		return new NodeOperationError(node, `${automation} could not be resumed, now in error`, {
			description:
				'Agentova accepted the request but could not restart the automation (for a CRM source, the connection to the CRM could not be restored). Resume it from the Agentova app.',
		});
	}

	return new NodeOperationError(node, `${automation} is "${obtained}" instead of "${requested}"`, {
		description:
			'Agentova did not apply the requested status. Check the automation in the Agentova app.',
	});
}

/**
 * postReceive de List et Get : une réponse d'erreur devient une NodeApiError
 * au texte anglais choisi par `error.code`.
 */
export async function explainApiError(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode >= 400) throw errorFromResponse(this.getNode(), response);
	return items;
}

/**
 * postReceive d'Activate et Pause : les erreurs comme `explainApiError`, puis le
 * statut RENVOYÉ doit être le statut demandé. Un 200 n'est pas un succès quand
 * l'automatisation n'est pas dans l'état voulu.
 */
export function expectStatus(requested: ControlStatus) {
	return async function (
		this: IExecuteSingleFunctions,
		items: INodeExecutionData[],
		response: IN8nHttpFullResponse,
	): Promise<INodeExecutionData[]> {
		if (response.statusCode >= 400) throw errorFromResponse(this.getNode(), response);

		const body = jsonBody(response.body);
		if (typeof body.status === 'string' && body.status !== requested) {
			throw statusMismatchError(this.getNode(), requested, body.status, body);
		}
		return items;
	};
}
