import { describe, expect, it } from 'vitest';
import { Workflow, type IDataObject, type INodeTypes } from 'n8n-workflow';
import { automationDescription } from '../nodes/Agentova/resources/automation';

// Résout le `request` de pagination avec le VRAI moteur d'expressions de n8n,
// comme le fait le routage déclaratif avant chaque page : `$request` est la
// requête d'origine, `$response` la réponse de la page précédente.

const nodeTypes = {
	getByName: () => ({ description: { properties: [] } }),
	getByNameAndVersion: () => ({ description: { properties: [] } }),
	getKnownTypes: () => ({}),
} as unknown as INodeTypes;

const workflow = new Workflow({
	id: 'pagination-test',
	nodes: [
		{
			id: 'node',
			name: 'Agentova',
			type: 'n8n-nodes-agentova-ai.agentova',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		},
	],
	connections: {},
	active: false,
	nodeTypes,
});

function nextPageQs(firstRequestQs: IDataObject, previousPage: IDataObject): IDataObject {
	const returnAll = automationDescription.find((property) => property.name === 'returnAll');
	const pagination = returnAll?.routing?.operations?.pagination;
	if (!pagination || typeof pagination !== 'object' || pagination.type !== 'generic') {
		throw new Error('Return All has no generic pagination');
	}
	const resolved = workflow.expression.getParameterValue(
		pagination.properties.request as IDataObject,
		null,
		0,
		0,
		'Agentova',
		[],
		'manual',
		{ $request: { qs: firstRequestQs }, $response: { body: previousPage } } as IDataObject,
		undefined,
		false,
	) as { qs: IDataObject };
	// Un paramètre `undefined` n'est pas envoyé par le client HTTP de n8n.
	return Object.fromEntries(Object.entries(resolved.qs).filter(([, value]) => value !== undefined));
}

describe('Return All pagination', () => {
	it('keeps the full page size from page 2 onward', () => {
		expect(nextPageQs({ limit: '100' }, { has_more: true, next_cursor: 'cur_2' })).toEqual({
			cursor: 'cur_2',
			limit: '100',
		});
	});

	it('keeps the Status, Type and Agent ID filters from page 2 onward', () => {
		const firstRequestQs = {
			limit: '100',
			status: 'paused',
			type: 'email_messages',
			agent_id: 'agt_1',
		};

		expect(nextPageQs(firstRequestQs, { has_more: true, next_cursor: 'cur_2' })).toEqual({
			...firstRequestQs,
			cursor: 'cur_2',
		});
	});

	it('sends no filter the user did not choose', () => {
		expect(nextPageQs({ limit: '100', status: 'active' }, { next_cursor: 'cur_2' })).toEqual({
			cursor: 'cur_2',
			limit: '100',
			status: 'active',
		});
	});
});
