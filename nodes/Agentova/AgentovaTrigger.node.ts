import type {
	IHookFunctions,
	IWebhookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import { createHmac, timingSafeEqual } from 'crypto';
import { AGENTOVA_ERROR, agentovaErrorCodeOf, httpStatusOf } from './helpers/apiError';

// Tolérance anti-rejeu du contrat (§4/§5) : une livraison dont `t` s'écarte de
// plus de 5 minutes de l'heure courante est rejetée, même signée correctement.
const SIGNATURE_TOLERANCE_SECONDS = 300;

// Déduplication des livraisons (contrat §5 : « une livraison peut être rejouée »,
// `id` = clé de déduplication du récepteur). La fenêtre anti-rejeu ci-dessus ne
// suffit pas : elle arrête un attaquant qui rejoue une vieille requête, pas
// Agentova qui RE-SIGNE une nouvelle tentative avec un horodatage frais, parfois
// des heures plus tard. Sans mémoire des `evt_…` déjà traités, le workflow
// repart — deux contacts dans le CRM, deux SMS.
//
// DEUX mémoires, parce qu'aucune ne suffit seule :
//   · en PROCESSUS (ci-dessous) — c'est elle qui fait le travail. Mesuré sur
//     n8n 2.39 : ce qu'un déclencheur écrit dans les données statiques PENDANT
//     `webhook()` n'est pas enregistré, la livraison suivante repart d'une
//     mémoire vide. Une Map de module, elle, vit d'une livraison à l'autre.
//     Limites assumées : elle ne survit pas à un redémarrage de n8n et n'est
//     pas partagée entre plusieurs processus (mode file d'attente). Le contrat
//     demande au récepteur de dédupliquer ; il ne promet pas l'exactement-une-fois.
//   · les données statiques du workflow — écrites quand même : sur une version
//     de n8n qui les enregistre, elles couvrent redémarrages et multi-processus.
// Les deux sont bornées en nombre ET en âge.
const DEDUP_MAX_EVENTS = 500;
const DEDUP_MAX_PROCESS_EVENTS = 5000;
const DEDUP_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type SeenEvents = Array<[id: string, seenAt: number]>;

/** Clé `${workflowId}:${eventId}` → instant de la première réception. */
const seenInProcess = new Map<string, number>();

function seenInThisProcess(key: string, now: number): boolean {
	const seenAt = seenInProcess.get(key);
	if (seenAt !== undefined && now - seenAt <= DEDUP_MAX_AGE_SECONDS) return true;

	seenInProcess.delete(key);
	seenInProcess.set(key, now);
	// Une Map itère dans l'ordre d'insertion : les premières clés sont les plus vieilles.
	for (const oldest of seenInProcess.keys()) {
		if (seenInProcess.size <= DEDUP_MAX_PROCESS_EVENTS) break;
		seenInProcess.delete(oldest);
	}
	return false;
}

function seenInStaticData(staticData: Record<string, unknown>, eventId: string, now: number): boolean {
	const stored = Array.isArray(staticData.seenEvents) ? (staticData.seenEvents as SeenEvents) : [];
	const fresh = stored.filter(([, seenAt]) => now - seenAt <= DEDUP_MAX_AGE_SECONDS);
	if (fresh.some(([id]) => id === eventId)) return true;

	fresh.push([eventId, now]);
	staticData.seenEvents = fresh.slice(-DEDUP_MAX_EVENTS);
	return false;
}

/** `true` si l'événement a déjà été traité ; sinon l'enregistre et rend `false`. */
function alreadyProcessed(
	staticData: Record<string, unknown>,
	workflowId: string,
	eventId: string,
	now: number,
): boolean {
	// Les DEUX sont évaluées (pas de court-circuit) : chacune doit enregistrer l'événement.
	const inProcess = seenInThisProcess(`${workflowId}:${eventId}`, now);
	const inStaticData = seenInStaticData(staticData, eventId, now);
	return inProcess || inStaticData;
}

/** Tests uniquement : repart d'une mémoire de processus vide. */
export function _resetProcessDeduplication(): void {
	seenInProcess.clear();
}

function parseSignatureHeader(header: string): { timestamp: string; signature: string } | null {
	let timestamp: string | undefined;
	let signature: string | undefined;
	for (const part of header.split(',')) {
		const [key, value] = part.trim().split('=');
		if (key === 't') timestamp = value;
		if (key === 'v1') signature = value;
	}
	if (!timestamp || !signature) return null;
	return { timestamp, signature };
}

// Patron du trigger Stripe officiel de n8n (StripeTriggerHelpers.ts) : HMAC sur
// le corps BRUT (pas le corps re-sérialisé par getBodyData), comparaison en
// temps constant pour ne pas fuiter la signature via le timing.
function isSignatureValid(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
	if (!rawBody || !header) return false;

	const parsed = parseSignatureHeader(header);
	if (!parsed) return false;

	const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parsed.timestamp));
	if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

	const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${rawBody.toString()}`).digest('hex');
	const expectedBuffer = Buffer.from(expected);
	const actualBuffer = Buffer.from(parsed.signature);

	return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export class AgentovaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agentova Trigger',
		name: 'agentovaTrigger',
		icon: { light: 'file:agentova.svg', dark: 'file:agentova.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when an Agentova workspace event occurs',
		defaults: {
			name: 'Agentova Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'agentovaApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				options: [
					{
						name: 'Automation Status Changed',
						value: 'automation.status_changed',
						description: 'An automation was activated or paused',
					},
					{
						name: 'Lead Created',
						value: 'lead.created',
						description: 'A new lead was captured, from any source',
					},
					{
						name: 'Run Completed',
						value: 'run.completed',
						description: 'An automation run finished — success, partial, or failed',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (webhookData.webhookId === undefined) return false;

				const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

				let response: { data: Array<{ id: string; disabled_at: string | null }> };
				try {
					response = (await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
						method: 'GET',
						baseURL: baseUrl,
						url: '/webhooks',
						json: true,
					})) as { data: Array<{ id: string; disabled_at: string | null }> };
				} catch (error) {
					// Route pas encore servie par l'API réelle (§ Disponibilité) : le contrat
					// répond alors `404 route_not_found`. On garde l'abonnement connu plutôt
					// que d'en recréer un à chaque activation. Tout AUTRE 404 (URL de base
					// fausse, proxy…) n'est pas une tolérance : il doit se voir.
					if (httpStatusOf(error) === 404 && agentovaErrorCodeOf(error) === AGENTOVA_ERROR.ROUTE_NOT_FOUND) {
						return true;
					}
					throw new NodeApiError(this.getNode(), error as JsonObject);
				}

				// Après des échecs de livraison prolongés, l'API désactive l'abonnement
				// (contrat §5) sans événement dédié — le seul signal est `disabled_at`
				// posé sur GET /webhooks. Un abonnement absent ou désactivé doit être
				// oublié pour que n8n en recrée un neuf, sinon le nœud reste silencieux.
				const webhook = response.data.find((w) => w.id === webhookData.webhookId);
				if (!webhook || webhook.disabled_at !== null) {
					delete webhookData.webhookId;
					delete webhookData.webhookSecret;
					return false;
				}

				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const events = this.getNodeParameter('events') as string[];
				const webhookData = this.getWorkflowStaticData('node');

				const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
					method: 'POST',
					baseURL: baseUrl,
					url: '/webhooks',
					body: { url: webhookUrl, events },
					json: true,
				})) as { id?: string; secret?: string };

				// Sans id ou secret, on stockerait `undefined` : checkExists répondrait
				// false et un abonnement serait recréé à chaque activation.
				if (!response.id || !response.secret) {
					// Un `id` sans `secret` : l'abonnement EXISTE côté Agentova mais on ne
					// pourra jamais vérifier ses livraisons. Le laisser en place, c'est en
					// créer un de plus à chaque nouvelle tentative d'activation, jusqu'au
					// quota du workspace. On le retire avant d'échouer (au mieux : l'erreur
					// qui compte est celle de la création, pas celle du ménage).
					if (response.id) {
						try {
							await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
								method: 'DELETE',
								baseURL: baseUrl,
								url: `/webhooks/${response.id}`,
								json: true,
							});
						} catch (cleanupError) {
							// On remonte l'erreur d'ORIGINE ci-dessous ; celle du ménage est
							// journalisée pour qu'un abonnement orphelin laisse une trace.
							this.logger.warn('Agentova: could not delete the webhook subscription created without a secret', {
								webhookId: response.id,
								status: httpStatusOf(cleanupError),
							});
						}
					}
					throw new NodeApiError(this.getNode(), response as JsonObject, {
						message: 'Agentova did not return an id and secret for the new webhook subscription',
					});
				}

				webhookData.webhookId = response.id;
				webhookData.webhookSecret = response.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (webhookData.webhookId === undefined) return true;

				const { baseUrl } = (await this.getCredentials('agentovaApi')) as { baseUrl: string };

				try {
					await this.helpers.httpRequestWithAuthentication.call(this, 'agentovaApi', {
						method: 'DELETE',
						baseURL: baseUrl,
						url: `/webhooks/${webhookData.webhookId}`,
						json: true,
					});
				} catch (error) {
					const code = httpStatusOf(error) === 404 ? agentovaErrorCodeOf(error) : undefined;
					// Route pas encore servie : on ne sait RIEN de l'état côté Agentova. On ne
					// bloque pas la désactivation du workflow, mais on garde l'identifiant
					// plutôt que d'oublier un abonnement qui existe peut-être.
					if (code === AGENTOVA_ERROR.ROUTE_NOT_FOUND) return true;
					// Abonnement déjà supprimé (contrat §4 : la suppression n'est pas
					// idempotente) — le but est atteint, on oublie l'identifiant ci-dessous.
					// Tout autre échec, 404 compris, remonte : l'abonnement vit peut-être encore.
					if (code !== AGENTOVA_ERROR.WEBHOOK_NOT_FOUND) {
						throw new NodeApiError(this.getNode(), error as JsonObject);
					}
				}

				delete webhookData.webhookId;
				delete webhookData.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const webhookData = this.getWorkflowStaticData('node');
		const secret = webhookData.webhookSecret as string | undefined;

		const headerValue = this.getHeaderData()['x-agentova-signature'];
		const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
		const rawBody = this.getRequestObject().rawBody;

		if (!secret || !isSignatureValid(rawBody, header, secret)) {
			this.getResponseObject().status(401).send('Unauthorized').end();
			return { noWebhookResponse: true };
		}

		const body = this.getBodyData();

		// Livraison authentique mais déjà traitée : on ACCUSE RÉCEPTION (sinon
		// Agentova la rejouerait encore) sans relancer le workflow. Un corps sans
		// `id` ne peut pas être dédupliqué : on le traite, comme avant.
		const eventId = typeof body.id === 'string' ? body.id : undefined;
		if (
			eventId &&
			alreadyProcessed(webhookData, String(this.getWorkflow().id ?? ''), eventId, Math.floor(Date.now() / 1000))
		) {
			this.getResponseObject().status(200).send('OK').end();
			return { noWebhookResponse: true };
		}

		return {
			workflowData: [[{ json: body }]],
		};
	}
}
