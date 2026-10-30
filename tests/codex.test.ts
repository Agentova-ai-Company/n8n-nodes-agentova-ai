import { describe, expect, it } from 'vitest';
import codex from '../nodes/Agentova/Agentova.node.json';
import { AgentovaApi } from '../credentials/AgentovaApi.credentials';

// Catégories admises par n8n (doc « Codex files » ; règle `valid-node-categories`
// du scanner officiel @n8n/scan-community-package). Le lint du dépôt ne connaît
// pas encore cette règle : sans ce test, « Developer Tools » repasserait au vert
// ici et serait refusé au scan.
const N8N_CATEGORIES = [
	'Data & Storage',
	'Finance & Accounting',
	'Marketing & Content',
	'Productivity',
	'Miscellaneous',
	'Sales',
	'Development',
	'Analytics',
	'Communication',
	'Utility',
];

describe('Agentova node codex and credential documentation', () => {
	it('uses only categories accepted by the n8n scanner', () => {
		expect(codex.categories.length).toBeGreaterThan(0);
		for (const category of codex.categories) {
			expect(N8N_CATEGORIES).toContain(category);
		}
	});

	it('points users to the Agentova documentation portal', () => {
		expect(codex.resources.primaryDocumentation[0].url).toBe(
			'https://docs.agentova.ai/n8n/overview',
		);
		expect(codex.resources.credentialDocumentation[0].url).toBe(
			'https://docs.agentova.ai/n8n/credentials',
		);
		expect(new AgentovaApi().documentationUrl).toBe('https://docs.agentova.ai/n8n/credentials');
	});
});
