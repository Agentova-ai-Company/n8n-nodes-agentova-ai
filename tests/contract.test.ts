import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
// `?raw` (Vite) : le texte du fichier sans importer `fs`, que le linter n8n
// refuse (no-restricted-imports) jusque dans les tests ; le mode strict du
// paquet interdit d'assouplir sa configuration.
import contractSource from '../annexes/openapi-v1.yaml?raw';
import { automationDescription } from '../nodes/Agentova/resources/automation';
import { MAX_PAGE_SIZE } from '../nodes/Agentova/resources/automation/list';
import { AgentovaTrigger } from '../nodes/Agentova/AgentovaTrigger.node';
import { AGENTOVA_ERROR, describeAgentovaError } from '../nodes/Agentova/helpers/apiError';
import { CONTROL_STATUS } from '../nodes/Agentova/helpers/controlResponse';

// Le contrat de l'API (annexe) est la source de vérité : ces tests LISENT ses
// codes, champs et énumérations au lieu de les recopier, jamais ses textes. S'ils
// cassent, c'est que le nœud a divergé du contrat : on corrige le nœud.

interface Schema {
	enum?: string[];
	properties?: Record<string, Schema>;
	maximum?: number;
}

interface Contract {
	paths: Record<
		string,
		Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>
	>;
	components: {
		schemas: Record<string, Schema>;
		parameters: Record<string, { schema: Schema }>;
	};
}

const contract = parse(contractSource) as Contract;

function contractEnum(schema: Schema | undefined, name: string): string[] {
	const values = schema?.enum;
	if (!values || values.length === 0) throw new Error(`The contract annex has no enum for ${name}`);
	return [...values].sort();
}

const schemaEnum = (name: string) => contractEnum(contract.components.schemas[name], name);

function optionValues(options: INodeProperties['options']): string[] {
	return ((options ?? []) as INodePropertyOptions[]).map((option) => String(option.value)).sort();
}

function listFilter(name: 'status' | 'type'): INodeProperties | undefined {
	const filters = automationDescription.find((property) => property.name === 'filters');
	return filters?.options?.find((option) => option.name === name) as INodeProperties | undefined;
}

function operation(value: string) {
	const operations = automationDescription.find((property) => property.name === 'operation');
	return (operations?.options as INodePropertyOptions[]).find((option) => option.value === value);
}

describe('Agentova node vs. the contract annex (annexes/openapi-v1.yaml)', () => {
	it('the List status filter offers exactly AutomationStatus', () => {
		expect(optionValues(listFilter('status')?.options)).toEqual(schemaEnum('AutomationStatus'));
	});

	it('the List type filter offers exactly AutomationType', () => {
		expect(optionValues(listFilter('type')?.options)).toEqual(schemaEnum('AutomationType'));
	});

	it('Activate and Pause send exactly the statuses accepted by PATCH /automations/{id}', () => {
		const body =
			contract.paths['/automations/{id}'].patch.requestBody?.content['application/json'].schema;
		const accepted = contractEnum(body?.properties?.status, 'PATCH /automations/{id} status');

		expect(Object.values(CONTROL_STATUS).sort()).toEqual(accepted);
		expect(operation('activate')?.routing?.request?.body).toEqual({ status: 'active' });
		expect(operation('pause')?.routing?.request?.body).toEqual({ status: 'paused' });
	});

	it('Return All asks for full pages: the maximum `limit` of the contract', () => {
		const returnAll = automationDescription.find((property) => property.name === 'returnAll');

		expect(MAX_PAGE_SIZE).toBe(contract.components.parameters.Limit.schema.maximum);
		expect(returnAll?.routing?.send).toMatchObject({
			paginate: '={{ $value }}',
			type: 'query',
			property: 'limit',
			value: String(MAX_PAGE_SIZE),
		});
	});

	it('every ErrorCode of the contract has its own English message (the API message is only a fallback)', () => {
		expect(Object.values(AGENTOVA_ERROR).sort()).toEqual(schemaEnum('ErrorCode'));

		for (const code of schemaEnum('ErrorCode')) {
			const { message } = describeAgentovaError({ code, message: 'API message' });
			expect(message).not.toBe('API message');
		}
	});
});

describe('Agentova Trigger vs. the contract annex', () => {
	it('offers exactly the WebhookEvent values', () => {
		const events = new AgentovaTrigger().description.properties.find(
			(property) => property.name === 'events',
		);

		expect(optionValues(events?.options)).toEqual(schemaEnum('WebhookEvent'));
	});

	it('reads fields that the Webhook schema declares (id, url, events, disabled_at)', () => {
		const fields = Object.keys(contract.components.schemas.Webhook.properties ?? {});

		expect(fields).toEqual(expect.arrayContaining(['id', 'url', 'events', 'disabled_at']));
	});
});
