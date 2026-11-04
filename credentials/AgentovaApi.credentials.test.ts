import { describe, expect, it } from 'vitest';
import { AgentovaApi } from './AgentovaApi.credentials';

// G1 (golden test, cadrage § Golden tests) : « Given une clé valide / invalide / révoquée,
// When le client teste ses credentials, Then test de connexion vert / message explicite ».
//
// Le node ne porte aucun code custom pour l'auth : `authenticate` et `test` sont déclaratifs.
// Sans `rules`, le testeur d'identifiants de n8n n'afficherait que le libellé HTTP
// (« Unauthorized ») : les règles par statut donnent le message explicite. Ce qu'on peut — et
// doit — vérifier ici, c'est que la déclaration elle-même est conforme au contrat : sinon une
// clé VALIDE échouerait (mauvais header, mauvais endpoint), ce qu'aucun test ne couvrait.
describe('AgentovaApi credentials vs. API contract v1', () => {
	const credential = new AgentovaApi();
	const field = (name: string) => credential.properties.find((p) => p.name === name);

	it('authenticates with `Authorization: Bearer <accessToken>` (contract §4, Auth)', () => {
		expect(credential.authenticate.type).toBe('generic');
		expect(credential.authenticate.properties.headers).toEqual({
			Authorization: '=Bearer {{$credentials.accessToken}}',
		});
	});

	it('tests the connection with `GET /automations?limit=1` (contract, recommended test endpoint)', () => {
		expect(credential.test.request.baseURL).toBe('={{$credentials.baseUrl}}');
		expect(credential.test.request.url).toBe('/automations');
		expect(credential.test.request.qs).toEqual({ limit: 1 });
	});

	it('explains each failure of the connection test in English, with what to do', () => {
		const messages = new Map(
			(credential.test.rules ?? []).map((rule) => [rule.properties.value, rule.properties.message]),
		);

		expect([...messages.keys()].sort()).toEqual([401, 403, 404, 429, 500, 503]);
		expect(messages.get(401)).toMatch(/^Invalid or revoked Agentova API key\..*Settings > API/);
		expect(messages.get(403)).toMatch(/^This Agentova workspace has no access to the API\./);
		expect(messages.get(404)).toMatch(/Restore the default Base URL/);
		for (const message of messages.values()) {
			expect(message).not.toMatch(/[éèêàùç]/);
		}
	});

	it('has no implicit mock mode: the default Base URL is the real API', () => {
		expect(field('baseUrl')?.default).toBe('https://core-api.agentova.ai/v1');
	});

	it('requires both fields, and the key is a password field that says where to create it', () => {
		expect(field('accessToken')?.required).toBe(true);
		expect(field('accessToken')?.typeOptions?.password).toBe(true);
		expect(field('accessToken')?.description).toMatch(/Settings > API/);
		expect(field('baseUrl')?.required).toBe(true);
	});
});
