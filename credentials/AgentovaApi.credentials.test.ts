import { describe, expect, it } from 'vitest';
import { AgentovaApi } from './AgentovaApi.credentials';

// G1 (golden test, cadrage § Golden tests) : « Given une clé valide / invalide / révoquée,
// When le client teste ses credentials, Then test de connexion vert / message explicite ».
//
// Le node ne porte aucun code custom pour l'auth : `authenticate` et `test` sont déclaratifs,
// et un 401/403 est surfacé tel quel par le credential test de n8n (message déjà explicite côté
// plateforme). Ce qu'on peut — et doit — vérifier ici, c'est que la déclaration elle-même est
// conforme au contrat : sinon une clé VALIDE échouerait (mauvais header, mauvais endpoint), ce
// qu'aucun test ne couvrait jusqu'ici.
describe('AgentovaApi credentials vs. contrat API v1', () => {
	const credential = new AgentovaApi();

	it('authentifie avec `Authorization: Bearer <accessToken>` (contrat §4, Auth)', () => {
		expect(credential.authenticate.type).toBe('generic');
		expect(credential.authenticate.properties.headers).toEqual({
			Authorization: '=Bearer {{$credentials.accessToken}}',
		});
	});

	it('teste la connexion sur `GET /automations?limit=1` (contrat, endpoint de test recommandé)', () => {
		expect(credential.test.request.baseURL).toBe('={{$credentials.baseUrl}}');
		expect(credential.test.request.url).toBe('/automations');
		expect(credential.test.request.qs).toEqual({ limit: 1 });
	});

	it("n'a pas de mode mock implicite : le Base URL par défaut pointe l'API réelle", () => {
		const baseUrlField = credential.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrlField?.default).toBe('https://core-api.agentova.ai/v1');
	});
});
