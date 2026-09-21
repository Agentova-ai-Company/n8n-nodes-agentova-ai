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
	response?: { status?: number; data?: unknown; body?: unknown };
	error?: unknown;
	cause?: unknown;
	context?: { data?: unknown };
}

/** Codes d'erreur du contrat Agentova v1 utiles au cycle de vie d'un abonnement. */
export const AGENTOVA_ERROR = {
	/** Route du contrat pas encore servie par l'API réelle (§ Disponibilité). */
	ROUTE_NOT_FOUND: 'route_not_found',
	/** Abonnement introuvable dans ce workspace (déjà supprimé). */
	WEBHOOK_NOT_FOUND: 'webhook_not_found',
} as const;

export function httpStatusOf(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const e = error as HttpErrorLike;
	for (const candidate of [e.status, e.statusCode, e.response?.status, e.httpCode]) {
		const status = Number(candidate);
		if (candidate !== undefined && candidate !== null && Number.isInteger(status) && status > 0) return status;
	}
	return e.cause !== undefined && e.cause !== error ? httpStatusOf(e.cause) : undefined;
}

function codeInBody(body: unknown): string | undefined {
	let parsed = body;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return undefined;
		}
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const code = (parsed as { error?: { code?: unknown } }).error?.code;
	return typeof code === 'string' ? code : undefined;
}

/**
 * Le `error.code` du corps de réponse Agentova (`{ error: { code, message } }`),
 * ou `undefined` si l'erreur ne vient pas de l'API (proxy, mauvaise URL…).
 */
export function agentovaErrorCodeOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const e = error as HttpErrorLike;
	for (const body of [e.response?.data, e.response?.body, e.error, e.context?.data]) {
		const code = codeInBody(body);
		if (code !== undefined) return code;
	}
	return e.cause !== undefined && e.cause !== error ? agentovaErrorCodeOf(e.cause) : undefined;
}
