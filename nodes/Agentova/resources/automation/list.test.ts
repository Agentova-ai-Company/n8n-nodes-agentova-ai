import { describe, expect, it } from 'vitest';
import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { automationListDescription } from './list';

// Valeurs du contrat API v1 (§3, ressource Automation) — si ce test casse,
// c'est que l'enum du nœud a divergé du contrat, pas l'inverse.
const CONTRACT_STATUS_VALUES = ['active', 'paused', 'draft', 'error'];
const CONTRACT_TYPE_VALUES = [
	'crm_source',
	'email_messages',
	'lead_ads',
	'social_comments',
	'social_messages',
	'social_story',
];

function getFilterOptions(name: 'status' | 'type'): string[] {
	const filters = automationListDescription.find((p): p is INodeProperties => p.name === 'filters');
	const field = filters?.options?.find((o) => o.name === name) as INodeProperties | undefined;
	const options = field?.options as INodePropertyOptions[] | undefined;
	return (options ?? []).map((o) => o.value as string);
}

describe('Automation list filters vs. contrat API v1', () => {
	it('le filtre status couvre exactement les 4 valeurs du contrat', () => {
		expect(getFilterOptions('status').sort()).toEqual([...CONTRACT_STATUS_VALUES].sort());
	});

	it('le filtre type couvre exactement les 5 valeurs du contrat', () => {
		expect(getFilterOptions('type').sort()).toEqual([...CONTRACT_TYPE_VALUES].sort());
	});
});
