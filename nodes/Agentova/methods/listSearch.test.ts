import { describe, expect, it, vi } from 'vitest';
import type { ILoadOptionsFunctions } from 'n8n-workflow';
import { searchAutomations } from './listSearch';

function fakeContext(automations: Array<{ id: string; name: string }>) {
	const httpRequestWithAuthentication = vi.fn().mockResolvedValue({ data: automations });
	const context = {
		helpers: { httpRequestWithAuthentication },
	} as unknown as ILoadOptionsFunctions;
	return { context, httpRequestWithAuthentication };
}

describe('searchAutomations', () => {
	it('calls GET /automations with the credential and returns name/value pairs', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ id: '1', name: 'Instagram Auto Reply' },
			{ id: '2', name: 'Paused Automation' },
		]);

		const result = await searchAutomations.call(context);

		expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
			'agentovaApi',
			expect.objectContaining({ method: 'GET', url: '/automations' }),
		);
		expect(result.results).toEqual([
			{ name: 'Instagram Auto Reply', value: '1' },
			{ name: 'Paused Automation', value: '2' },
		]);
	});

	it('filters results by name, case-insensitively', async () => {
		const { context } = fakeContext([
			{ id: '1', name: 'Instagram Auto Reply' },
			{ id: '2', name: 'Paused Automation' },
		]);

		const result = await searchAutomations.call(context, 'PAUSED');

		expect(result.results).toEqual([{ name: 'Paused Automation', value: '2' }]);
	});

	it('returns an empty result set on an empty workspace (G4)', async () => {
		const { context } = fakeContext([]);

		const result = await searchAutomations.call(context);

		expect(result.results).toEqual([]);
	});
});
