import type { IDataObject, INode, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

// Lecture d'une erreur HTTP remontée par les helpers n8n.
//
// La forme RÉELLE, mesurée dans n8n : `httpRequest` rejette une AxiosError qui
// porte `status` et `response.status` — PAS `statusCode` ni `httpCode`. Ces deux
// derniers n'existent que sur les erreurs de l'ancien helper `request` et sur
// NodeApiError. Ne tester qu'eux, c'est écrire une tolérance qui ne se
// déclenche jamais en conditions réelles. On lit donc toutes les formes.

interface HttpErrorLike {
	status?: number;
	statusCode?: number;
	httpCode?: string | number | null;
	response?: { status?: number; data?: unknown; body?: unknown; headers?: unknown };
	error?: unknown;
	cause?: unknown;
	context?: { data?: unknown };
}

/** Codes d'erreur du contrat Agentova v1 (`ErrorCode`, liste fermée). */
export const AGENTOVA_ERROR = {
	INVALID_REQUEST: 'invalid_request',
	INVALID_API_KEY: 'invalid_api_key',
	WORKSPACE_ACCESS_DENIED: 'workspace_access_denied',
	AUTOMATION_NOT_FOUND: 'automation_not_found',
	WEBHOOK_NOT_FOUND: 'webhook_not_found',
	ROUTE_NOT_FOUND: 'route_not_found',
	AUTOMATION_NOT_CONTROLLABLE: 'automation_not_controllable',
	RATE_LIMITED: 'rate_limited',
	INTERNAL_ERROR: 'internal_error',
	SERVICE_UNAVAILABLE: 'service_unavailable',
} as const;

export type AgentovaErrorCode = (typeof AGENTOVA_ERROR)[keyof typeof AGENTOVA_ERROR];

/** Le contenu de `error` dans le corps d'erreur du contrat : `{ error: { code, message, details } }`. */
export interface AgentovaError {
	code: string;
	message?: string;
	details?: IDataObject;
}

export interface ErrorText {
	message: string;
	description?: string;
}

const FIX_IN_APP = 'Activate it or fix it once from the Agentova app, then retry.';

// Le message de l'API n'est jamais affiché pour un code connu : le contrat le
// dit changeant (« brancher sur `code` »), et il était en français jusqu'au
// draft.6. n8n exige l'anglais pour tout texte d'erreur. Le message de l'API
// ne sert que de repli, pour un code que ce nœud ne connaît pas encore.
const ERROR_TEXT: Record<AgentovaErrorCode, ErrorText> = {
	invalid_request: {
		message: 'Agentova rejected the request as invalid',
		description: 'A parameter or the request body is invalid.',
	},
	invalid_api_key: {
		message: 'Invalid or revoked Agentova API key',
		description:
			'Check the Access Token of the Agentova credential. A workspace admin can create a new key in Agentova under Settings > API.',
	},
	workspace_access_denied: {
		message: 'This Agentova workspace has no access to the API',
		description:
			'The API key is valid, but the subscription of the workspace does not allow API access (unpaid, paused or never completed). Check the billing settings in Agentova.',
	},
	automation_not_found: {
		message: 'Automation not found',
		description:
			'No automation with this ID exists in the workspace of this API key. It may have been deleted, or its connected account disconnected.',
	},
	webhook_not_found: {
		message: 'Webhook subscription not found',
		description:
			'The webhook subscription does not exist in this workspace, or it was already deleted.',
	},
	route_not_found: {
		message: 'Agentova API route not found',
		description:
			'The API at the Base URL of the Agentova credential does not serve this operation. Keep the default Base URL (https://core-api.agentova.ai/v1) unless Agentova gave you another one.',
	},
	automation_not_controllable: {
		message: 'This automation cannot be controlled through the API',
		description: `The automation is in draft or in error. ${FIX_IN_APP}`,
	},
	rate_limited: {
		message: 'Agentova rate limit reached',
		description:
			'This API key sent too many requests. The quota is shared by every workflow that uses the key: slow the workflow down, for example with a Wait node or smaller batches.',
	},
	internal_error: {
		message: 'Agentova internal error',
		description:
			'Agentova could not process the request. Retry later; if the error persists, contact Agentova support.',
	},
	service_unavailable: {
		message: 'The Agentova API is temporarily unavailable',
		description:
			'Agentova has switched the API off for a while. Retry later; events that happen meanwhile can be caught up with the list operations.',
	},
};

// Motifs de refus d'une URL d'abonnement (contrat, `POST /webhooks`, `details.reason`).
const WEBHOOK_URL_REJECTION: Record<string, string> = {
	https_required:
		"Agentova only delivers events to HTTPS addresses. Set n8n's WEBHOOK_URL to a public https:// address.",
	credentials_in_url: 'The webhook URL must not contain a username or a password.',
	local_address:
		'Agentova cannot deliver events to a local address. n8n must be reachable from the internet at its WEBHOOK_URL.',
	private_address:
		'Agentova cannot deliver events to a private network address. n8n must be reachable from the internet at its WEBHOOK_URL.',
	unresolvable_host: "The host of the webhook URL could not be resolved. Check n8n's WEBHOOK_URL.",
	invalid_url: "The webhook URL is invalid. Check n8n's WEBHOOK_URL.",
	url_too_long: 'The webhook URL is too long.',
};

function isKnownCode(code: string): code is AgentovaErrorCode {
	return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code);
}

/** `Retry-After` en secondes (le contrat n'en émet pas d'autre forme), sinon `undefined`. */
export function parseRetryAfter(value: unknown): number | undefined {
	const raw: unknown = Array.isArray(value) ? value[0] : value;
	if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) return undefined;
	const seconds = Number(raw);
	return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function invalidRequestDescription(details: IDataObject | undefined): string | undefined {
	if (!details) return undefined;
	if (typeof details.max === 'number') {
		return `The workspace already has the maximum number of active webhook subscriptions (${details.max}). Deactivate the workflows or tools you no longer use, then retry.`;
	}
	const parameter = typeof details.parameter === 'string' ? details.parameter : undefined;
	const reason = typeof details.reason === 'string' ? details.reason : undefined;
	if (parameter === 'url' && reason && WEBHOOK_URL_REJECTION[reason])
		return WEBHOOK_URL_REJECTION[reason];
	if (parameter && reason) return `The parameter "${parameter}" was rejected (${reason}).`;
	if (parameter) return `The parameter "${parameter}" is invalid.`;
	return undefined;
}

/**
 * Texte anglais d'une erreur Agentova, choisi par `error.code` ; repli sur
 * `error.message` pour un code inconnu.
 */
export function describeAgentovaError(error: AgentovaError, retryAfterSeconds?: number): ErrorText {
	if (!isKnownCode(error.code)) {
		return { message: error.message || `Agentova API error (${error.code})` };
	}

	const text = ERROR_TEXT[error.code];

	if (error.code === AGENTOVA_ERROR.RATE_LIMITED) {
		const seconds = retryAfterSeconds ?? parseRetryAfter(error.details?.retry_after_seconds);
		const wait = seconds === undefined ? 'retry later' : `retry in ${seconds} s`;
		return { message: `${text.message}, ${wait}`, description: text.description };
	}

	if (error.code === AGENTOVA_ERROR.INVALID_REQUEST) {
		return {
			message: text.message,
			description: invalidRequestDescription(error.details) ?? text.description,
		};
	}

	// Reprise d'une automatisation e-mail dont la boîte est déjà écoutée par un
	// autre agent actif : règle de l'app Agentova, une boîte, un agent.
	if (
		error.code === AGENTOVA_ERROR.AUTOMATION_NOT_CONTROLLABLE &&
		error.details?.reason === 'account_in_use'
	) {
		return {
			message: 'This mailbox is already used by another active Agentova agent',
			description:
				'A mailbox can only be used by one active agent. Detach it from the other agent in the Agentova app, then retry.',
		};
	}

	if (
		error.code === AGENTOVA_ERROR.AUTOMATION_NOT_CONTROLLABLE &&
		typeof error.details?.status === 'string'
	) {
		return {
			message: text.message,
			description: `The automation is in ${error.details.status}. ${FIX_IN_APP}`,
		};
	}

	return text;
}

/** Le `error` d'un corps Agentova (objet ou JSON brut), ou `undefined` si ce n'en est pas un. */
export function agentovaErrorInBody(body: unknown): AgentovaError | undefined {
	let parsed = body;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return undefined;
		}
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const error = (parsed as { error?: unknown }).error;
	if (typeof error !== 'object' || error === null) return undefined;
	const { code, message, details } = error as {
		code?: unknown;
		message?: unknown;
		details?: unknown;
	};
	if (typeof code !== 'string') return undefined;
	return {
		code,
		message: typeof message === 'string' ? message : undefined,
		details: typeof details === 'object' && details !== null ? (details as IDataObject) : undefined,
	};
}

export function httpStatusOf(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const e = error as HttpErrorLike;
	for (const candidate of [e.status, e.statusCode, e.response?.status, e.httpCode]) {
		const status = Number(candidate);
		if (candidate !== undefined && candidate !== null && Number.isInteger(status) && status > 0)
			return status;
	}
	return e.cause !== undefined && e.cause !== error ? httpStatusOf(e.cause) : undefined;
}

/**
 * Le `error` du corps de réponse Agentova (`{ error: { code, message } }`),
 * ou `undefined` si l'erreur ne vient pas de l'API (proxy, mauvaise URL…).
 */
export function agentovaErrorOf(error: unknown): AgentovaError | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const e = error as HttpErrorLike;
	for (const body of [e.response?.data, e.response?.body, e.error, e.context?.data]) {
		const found = agentovaErrorInBody(body);
		if (found !== undefined) return found;
	}
	return e.cause !== undefined && e.cause !== error ? agentovaErrorOf(e.cause) : undefined;
}

export function agentovaErrorCodeOf(error: unknown): string | undefined {
	return agentovaErrorOf(error)?.code;
}

function retryAfterOf(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const e = error as HttpErrorLike;
	const headers = e.response?.headers;
	if (typeof headers === 'object' && headers !== null) {
		const seconds = parseRetryAfter((headers as Record<string, unknown>)['retry-after']);
		if (seconds !== undefined) return seconds;
	}
	return e.cause !== undefined && e.cause !== error ? retryAfterOf(e.cause) : undefined;
}

/**
 * NodeApiError d'une réponse d'erreur Agentova, avec le texte anglais de son code.
 *
 * On passe à NodeApiError le corps seul, jamais l'AxiosError : avec une
 * AxiosError, n8n REMPLACE la description fournie par `response.data.error.message`,
 * c'est-à-dire le message de l'API (lu dans le code de n8n-workflow).
 */
export function agentovaNodeApiError(
	node: INode,
	error: AgentovaError,
	httpStatus: number | undefined,
	retryAfterSeconds?: number,
): NodeApiError {
	const { message, description } = describeAgentovaError(error, retryAfterSeconds);
	return new NodeApiError(node, { error: { ...error } } as JsonObject, {
		httpCode: httpStatus === undefined ? undefined : String(httpStatus),
		message,
		description,
	});
}

/** Erreur levée par un helper HTTP de n8n → NodeApiError au texte choisi par `error.code`. */
export function toNodeApiError(node: INode, error: unknown): NodeApiError {
	const agentovaError = agentovaErrorOf(error);
	if (agentovaError === undefined) return new NodeApiError(node, error as JsonObject);
	return agentovaNodeApiError(node, agentovaError, httpStatusOf(error), retryAfterOf(error));
}
