import { describe, expect, it } from 'vitest';
import type { IExecuteSingleFunctions, IN8nHttpFullResponse, INodeExecutionData } from 'n8n-workflow';
import { explainControlError } from './controlResponse';

const context = { getNode: () => ({ name: 'Agentova' }) } as unknown as IExecuteSingleFunctions;
const items: INodeExecutionData[] = [{ json: { id: 'aut_1', status: 'paused' } }];
const response = (statusCode: number, body: unknown) => ({ statusCode, body, headers: {} }) as IN8nHttpFullResponse;

describe('explainControlError (Activate / Pause)', () => {
	it('passes a successful response through untouched', async () => {
		expect(await explainControlError.call(context, items, response(200, items[0].json))).toBe(items);
	});

	it('pausing an already-paused automation stays a plain 200, no error (G5, contrat §Ressources, idempotence)', async () => {
		const alreadyPaused: INodeExecutionData[] = [{ json: { id: 'aut_1', status: 'paused' } }];
		const body = { id: 'aut_1', status: 'paused' };
		await expect(explainControlError.call(context, alreadyPaused, response(200, body))).resolves.toBe(
			alreadyPaused,
		);
	});

	it('explains route_not_found instead of a bare 404 (contrat § Disponibilité)', async () => {
		const body = { error: { code: 'route_not_found', message: 'x', details: {} } };
		await expect(explainControlError.call(context, items, response(404, body))).rejects.toThrow(
			/not available yet/,
		);
	});

	it('keeps every other error an ordinary API error', async () => {
		const notFound = { error: { code: 'automation_not_found', message: 'x', details: {} } };
		await expect(explainControlError.call(context, items, response(404, notFound))).rejects.not.toThrow(
			/not available yet/,
		);
		const draft = { error: { code: 'automation_not_controllable', message: 'x', details: {} } };
		await expect(explainControlError.call(context, items, response(422, draft))).rejects.toThrow();
	});
});
