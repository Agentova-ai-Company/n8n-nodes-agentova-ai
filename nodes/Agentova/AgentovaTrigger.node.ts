import type {
	IDataObject,
	IHookFunctions,
	IHttpRequestOptions,
	IWebhookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { createHmac, timingSafeEqual } from 'crypto';
import {
	AGENTOVA_ERROR,
	agentovaErrorCodeOf,
	httpStatusOf,
	toNodeApiError,
} from './helpers/apiError';

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
// La clé porte le NŒUD, pas seulement le workflow : Agentova envoie le même
// `evt_` à chacun de ses abonnements. Deux déclencheurs Agentova d'un même
// workflow, abonnés au même événement, doivent chacun s'exécuter une fois.
//
// DEUX mémoires, parce qu'aucune ne suffit seule :
//   · en PROCESSUS (ci-dessous) — c'est elle qui fait le travail. Mesuré sur
//     n8n 2.39 : ce qu'un déclencheur écrit dans les données statiques PENDANT
//     `webhook()` n'est pas enregistré, la livraison suivante repart d'une
//     mémoire vide. Une Map de module, elle, vit d'une livraison à l'autre. Les
//     helpers de déduplication persistante de n8n (`checkProcessedAndRecord`)
//     n'existent pas pour `IWebhookFunctions` (vérifié, n8n-workflow 2.38.1).
//     Limites assumées : elle ne survit pas à un redémarrage de n8n et n'est
//     pas partagée entre plusieurs processus (mode file d'attente). Le contrat
//     demande au récepteur de dédupliquer ; il ne promet pas l'exactement-une-fois.
//     Le README recommande le nœud « Remove Duplicates » pour aller au-delà.
//   · les données statiques du nœud — écrites quand même : sur une version de
//     n8n qui les enregistre, elles couvrent redémarrages et multi-processus.
// Les deux sont bornées en âge ET en nombre. L'âge d'abord : Agentova ne
// programme aucune nouvelle tentative plus de 36 h après la création de
// l'événement, et le contrat demande de garder les `id` 48 h ; 72 h laissent
// une marge. Le nombre ensuite, seulement pour borner la mémoire : avec 5 000
// clés partagées par tous les déclencheurs du processus, un volume soutenu
// évinçait des événements de quelques heures, et leur nouvelle tentative
// relançait le workflow.
const DEDUP_MAX_EVENTS = 500;
const DEDUP_MAX_PROCESS_EVENTS = 50_000;
const DEDUP_MAX_AGE_SECONDS = 72 * 60 * 60;

type SeenEvents = Array<[id: string, seenAt: number]>;

/** Clé `${workflowId}:${nodeId}:${eventId}` → instant de la première réception. */
const seenInProcess = new Map<string, number>();

function seenInThisProcess(key: string, now: number): boolean {
	const seenAt = seenInProcess.get(key);
	if (seenAt !== undefined && now - seenAt <= DEDUP_MAX_AGE_SECONDS) return true;

	seenInProcess.delete(key);
	seenInProcess.set(key, now);
	// Une Map itère dans l'ordre d'insertion : les premières clés sont les plus
	// vieilles. On retire ce qui a passé l'âge, puis le surplus éventuel.
	for (const [oldest, oldestSeenAt] of seenInProcess) {
		const expired = now - oldestSeenAt > DEDUP_MAX_AGE_SECONDS;
		if (!expired && seenInProcess.size <= DEDUP_MAX_PROCESS_EVENTS) break;
		seenInProcess.delete(oldest);
	}
	return false;
}

function seenInStaticData(staticData: IDataObject, eventId: string, now: number): boolean {
	const stored = Array.isArray(staticData.seenEvents) ? (staticData.seenEvents as SeenEvents) : [];
	const fresh = stored.filter(([, seenAt]) => now - seenAt <= DEDUP_MAX_AGE_SECONDS);
	if (fresh.some(([id]) => id === eventId)) return true;

	fresh.push([eventId, now]);
	staticData.seenEvents = fresh.slice(-DEDUP_MAX_EVENTS);
	return false;
}

/**
 * `true` si ce nœud a déjà traité l'événement ; sinon l'enregistre et rend `false`.
 * `scope` = `${workflowId}:${nodeId}`.
 */
function alreadyProcessed(
	staticData: IDataObject,
	scope: string,
	eventId: string,
	now: number,
): boolean {
	// Les DEUX sont évaluées (pas de court-circuit) : chacune doit enregistrer l'événement.
	const inProcess = seenInThisProcess(`${scope}:${eventId}`, now);
	const inStaticData = seenInStaticData(staticData, eventId, now);
	return inProcess || inStaticData;
}

/** Tests uniquement : repart d'une mémoire de processus vide. */
export function _resetProcessDeduplication(): void {
	seenInProcess.clear();
}

/** Tests uniquement : nombre d'événements retenus par la mémoire de processus. */
export function _processDeduplicationSize(): number {
	return seenInProcess.size;
}

// Motifs d'un refus de livraison, journalisés tels quels. Jamais le secret, la
// signature ni le corps : le journal de n8n n'est pas un coffre.
const SIGNATURE_REJECTION = {
	NO_SECRET: 'no_secret',
	MISSING_SIGNATURE: 'missing_signature',
	MALFORMED_SIGNATURE: 'malformed_signature',
	STALE_TIMESTAMP: 'stale_timestamp',
	MISSING_BODY: 'missing_body',
	SIGNATURE_MISMATCH: 'signature_mismatch',
} as const;

type SignatureRejection = (typeof SIGNATURE_REJECTION)[keyof typeof SIGNATURE_REJECTION];

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
/** Le motif du refus, ou `undefined` si la livraison est authentique et fraîche. */
function signatureRejection(
	rawBody: Buffer | undefined,
	header: string | undefined,
	secret: string | undefined,
	nowSeconds: number,
): SignatureRejection | undefined {
	if (!secret) return SIGNATURE_REJECTION.NO_SECRET;
	if (!header) return SIGNATURE_REJECTION.MISSING_SIGNATURE;

	const parsed = parseSignatureHeader(header);
	const timestamp = parsed ? Number(parsed.timestamp) : Number.NaN;
	if (!parsed || !Number.isFinite(timestamp)) return SIGNATURE_REJECTION.MALFORMED_SIGNATURE;
	if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS)
		return SIGNATURE_REJECTION.STALE_TIMESTAMP;
	if (!rawBody) return SIGNATURE_REJECTION.MISSING_BODY;

	const expected = createHmac('sha256', secret)
		.update(`${parsed.timestamp}.${rawBody.toString()}`)
		.digest('hex');
	const expectedBuffer = Buffer.from(expected);
	const actualBuffer = Buffer.from(parsed.signature);
	const valid =
		expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
	return valid ? undefined : SIGNATURE_REJECTION.SIGNATURE_MISMATCH;
}

/** Abonnement tel que servi par `GET /webhooks` (contrat, schéma `Webhook`). */
interface WebhookSubscription {
	id: string;
	url: string;
	events: string[];
	disabled_at: string | null;
}

// Pourquoi un abonnement connu ne peut pas être gardé tel quel.
const STALE_SUBSCRIPTION = {
	DISABLED: 'disabled_by_agentova',
	URL_CHANGED: 'webhook_url_changed',
	EVENTS_CHANGED: 'events_changed',
	NO_SECRET: 'secret_missing',
} as const;

type StaleSubscription = (typeof STALE_SUBSCRIPTION)[keyof typeof STALE_SUBSCRIPTION];

function sameEvents(left: string[], right: string[]): boolean {
	const a = new Set(left);
	const b = new Set(right);
	return a.size === b.size && [...a].every((event) => b.has(event));
}

function staleReasonOf(
	subscription: WebhookSubscription,
	webhookUrl: string,
	events: string[],
	hasSecret: boolean,
): StaleSubscription | undefined {
	// Après des échecs de livraison prolongés, l'API désactive l'abonnement
	// (contrat §5) sans événement dédié : le seul signal est `disabled_at`.
	if (subscription.disabled_at !== null) return STALE_SUBSCRIPTION.DISABLED;
	// WEBHOOK_URL de n8n changée (tunnel, migration) : les livraisons partiraient
	// encore à l'ancienne adresse, qui n'est peut-être plus la nôtre.
	if (subscription.url !== webhookUrl) return STALE_SUBSCRIPTION.URL_CHANGED;
	if (!sameEvents(subscription.events ?? [], events)) return STALE_SUBSCRIPTION.EVENTS_CHANGED;
	// Sans secret, aucune livraison ne pourrait être vérifiée : toutes seraient refusées.
	if (!hasSecret) return STALE_SUBSCRIPTION.NO_SECRET;
	return undefined;
}

function forgetSubscription(webhookData: IDataObject): void {
	delete webhookData.webhookId;
	delete webhookData.webhookSecret;
}

// Un nœud se reconnaît à la FIN de son URL de webhook, `/<webhookId>/webhook` :
// l'hôte et le préfixe changent avec WEBHOOK_URL (tunnel, migration), pas elle.
// Avant n8n 2.36, un workflow dupliqué hérite des données statiques de
// l'original — son abonnement, son secret — mais reçoit de nouveaux
// `webhookId` de nœud : un abonnement dont la fin d'URL diffère appartient à
// un AUTRE nœud, toujours actif. Le supprimer couperait l'original.
function nodeWebhookPathOf(url: string): string | undefined {
	try {
		return new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/');
	} catch {
		return undefined;
	}
}

function belongsToAnotherNode(subscriptionUrl: string, webhookUrl: string): boolean {
	if (subscriptionUrl === webhookUrl) return false;
	const ownPath = nodeWebhookPathOf(webhookUrl);
	// Fin d'URL illisible : dans le doute, on ne supprime pas.
	return ownPath === undefined || nodeWebhookPathOf(subscriptionUrl) !== ownPath;
}

async function agentovaRequest(
	context: IHookFunctions,
	options: IHttpRequestOptions,
): Promise<unknown> {
	const { baseUrl } = await context.getCredentials<{ baseUrl: string }>('agentovaApi');
	try {
		return await context.helpers.httpRequestWithAuthentication.call(context, 'agentovaApi', {
			...options,
			baseURL: baseUrl,
			json: true,
		});
	} catch (error) {
		throw toNodeApiError(context.getNode(), error);
	}
}

async function listSubscriptions(context: IHookFunctions): Promise<WebhookSubscription[]> {
	const response = (await agentovaRequest(context, { method: 'GET', url: '/webhooks' })) as {
		data?: unknown;
	};
	if (!Array.isArray(response?.data)) {
		throw new NodeOperationError(
			context.getNode(),
			'Unexpected response from Agentova when listing webhook subscriptions',
		);
	}
	return response.data as WebhookSubscription[];
}

/** Supprime un abonnement ; déjà supprimé (`webhook_not_found`), le but est atteint. */
async function deleteSubscription(context: IHookFunctions, id: string): Promise<void> {
	const { baseUrl } = await context.getCredentials<{ baseUrl: string }>('agentovaApi');
	try {
		await context.helpers.httpRequestWithAuthentication.call(context, 'agentovaApi', {
			method: 'DELETE',
			baseURL: baseUrl,
			url: `/webhooks/${id}`,
			json: true,
		});
	} catch (error) {
		// Contrat §4 : la suppression n'est pas idempotente (204 une seule fois).
		// Tout autre échec, 404 compris, remonte : l'abonnement vit peut-être encore.
		if (agentovaErrorCodeOf(error) === AGENTOVA_ERROR.WEBHOOK_NOT_FOUND) return;
		throw toNodeApiError(context.getNode(), error);
	}
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
						description: 'An automation was activated, paused, or went into error',
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

				const subscription = (await listSubscriptions(this)).find(
					(s) => s.id === webhookData.webhookId,
				);
				if (subscription === undefined) {
					// Supprimé côté Agentova : rien à nettoyer, n8n en recrée un.
					forgetSubscription(webhookData);
					return false;
				}

				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				if (belongsToAnotherNode(subscription.url, webhookUrl)) {
					// Hérité d'un workflow dupliqué : l'oublier, JAMAIS le supprimer.
					this.logger.warn('Agentova Trigger: ignoring a webhook subscription of another node', {
						reason: 'inherited_from_another_node',
					});
					forgetSubscription(webhookData);
					return false;
				}

				// Un abonnement périmé n'est ni gardé ni abandonné : il est supprimé,
				// puis n8n en crée un neuf (`create`). L'oublier sans le supprimer
				// laisserait un abonnement actif vers une adresse morte, compté dans
				// le plafond du workspace.
				const staleReason = staleReasonOf(
					subscription,
					webhookUrl,
					this.getNodeParameter('events') as string[],
					typeof webhookData.webhookSecret === 'string' && webhookData.webhookSecret !== '',
				);
				if (staleReason === undefined) return true;

				this.logger.warn('Agentova Trigger: replacing a stale webhook subscription', {
					reason: staleReason,
				});
				await deleteSubscription(this, subscription.id);
				forgetSubscription(webhookData);
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events') as string[];
				const webhookData = this.getWorkflowStaticData('node');

				// Orphelins d'une activation ratée : quand l'activation échoue APRÈS
				// `create` (un autre déclencheur du workflow, par exemple), n8n relit
				// les données statiques en base, sans le nouvel identifiant — son
				// `delete` ne le voit pas. Chaque nouvel essai en laisserait un de
				// plus, jusqu'au plafond de 20 abonnements actifs. L'URL de webhook
				// d'un nœud n8n est propre à ce nœud : tout abonnement qui la porte est
				// un reste de ce nœud, supprimé avant d'en créer un neuf.
				const orphans = (await listSubscriptions(this)).filter((s) => s.url === webhookUrl);
				for (const orphan of orphans) {
					await deleteSubscription(this, orphan.id);
				}
				if (orphans.length > 0) {
					this.logger.warn(
						'Agentova Trigger: deleted leftover webhook subscriptions for this node',
						{
							count: orphans.length,
						},
					);
				}

				const response = (await agentovaRequest(this, {
					method: 'POST',
					url: '/webhooks',
					body: { url: webhookUrl, events },
				})) as { id?: string; secret?: string };

				// Sans id ou secret, on stockerait `undefined` : checkExists répondrait
				// false et un abonnement serait recréé à chaque activation.
				if (!response?.id || !response.secret) {
					// Un `id` sans `secret` : l'abonnement EXISTE côté Agentova mais on ne
					// pourra jamais vérifier ses livraisons. Le laisser en place, c'est en
					// créer un de plus à chaque nouvelle tentative d'activation, jusqu'au
					// quota du workspace. On le retire avant d'échouer (au mieux : l'erreur
					// qui compte est celle de la création, pas celle du ménage).
					if (response?.id) {
						try {
							await deleteSubscription(this, response.id);
						} catch (cleanupError) {
							// On remonte l'erreur d'ORIGINE ci-dessous ; celle du ménage est
							// journalisée pour qu'un abonnement orphelin laisse une trace.
							this.logger.warn(
								'Agentova: could not delete the webhook subscription created without a secret',
								{
									webhookId: response.id,
									status: httpStatusOf(cleanupError),
								},
							);
						}
					}
					throw new NodeApiError(this.getNode(), (response ?? {}) as JsonObject, {
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

				// Tout échec autre que « déjà supprimé » remonte, et l'identifiant est
				// gardé : l'abonnement vit peut-être encore.
				await deleteSubscription(this, webhookData.webhookId as string);
				forgetSubscription(webhookData);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const webhookData = this.getWorkflowStaticData('node');
		const secret =
			typeof webhookData.webhookSecret === 'string' ? webhookData.webhookSecret : undefined;

		const headerValue = this.getHeaderData()['x-agentova-signature'];
		const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
		const rawBody = this.getRequestObject().rawBody;
		const now = Math.floor(Date.now() / 1000);

		const rejection = signatureRejection(rawBody, header, secret, now);
		if (rejection !== undefined) {
			// Le motif, et de quoi retrouver le nœud ; jamais le secret, la signature
			// ni le corps. Sans cette trace, une livraison refusée (secret
			// désynchronisé, horloge décalée…) est invisible côté n8n.
			this.logger.warn('Agentova Trigger: rejected a webhook delivery', {
				reason: rejection,
				workflowId: this.getWorkflow().id,
				node: this.getNode().name,
			});
			this.getResponseObject().status(401).send('Unauthorized').end();
			return { noWebhookResponse: true };
		}

		const body = this.getBodyData();

		// Livraison authentique mais déjà traitée par CE nœud : on ACCUSE RÉCEPTION
		// (sinon Agentova la rejouerait encore) sans relancer le workflow. Un corps
		// sans `id` ne peut pas être dédupliqué : on le traite, comme avant.
		const eventId = typeof body.id === 'string' ? body.id : undefined;
		const scope = `${this.getWorkflow().id ?? ''}:${this.getNode().id}`;
		if (eventId && alreadyProcessed(webhookData, scope, eventId, now)) {
			this.getResponseObject().status(200).send('OK').end();
			return { noWebhookResponse: true };
		}

		return {
			workflowData: [[{ json: body }]],
		};
	}
}
