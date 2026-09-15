import { describe, expect, it, vi } from 'vitest';
import type { ILoadOptionsFunctions } from 'n8n-workflow';
import { searchAutomations } from './listSearch';

function fakeContext(pages: Array<Array<{ id: string; name: string }>>) {
	const httpRequestWithAuthentication = vi.fn();
	pages.forEach((data, index) => {
		const hasMore = index < pages.length - 1;
		httpRequestWithAuthentication.mockResolvedValueOnce({
			data,
			has_more: hasMore,
			next_cursor: hasMore ? `cursor-${index + 1}` : null,
		});
	});
	const getCredentials = vi.fn().mockResolvedValue({ baseUrl: 'https://api.agentova.ai/v1' });
	const context = {
		helpers: { httpRequestWithAuthentication },
		getCredentials,
	} as unknown as ILoadOptionsFunctions;
	return { context, httpRequestWithAuthentication };
}

describe('searchAutomations', () => {
	it('calls GET /automations with the credential base URL and returns name/value pairs', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			[
				{ id: '1', name: 'Instagram Auto Reply' },
				{ id: '2', name: 'Paused Automation' },
			],
		]);

		const result = await searchAutomations.call(context);

		expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
			'agentovaApi',
			expect.objectContaining({
				method: 'GET',
				baseURL: 'https://api.agentova.ai/v1',
				url: '/automations',
			}),
		);
		expect(result.results).toEqual([
			{ name: 'Instagram Auto Reply', value: '1' },
			{ name: 'Paused Automation', value: '2' },
		]);
	});

	it('filters results by name, case-insensitively', async () => {
		const { context } = fakeContext([
			[
				{ id: '1', name: 'Instagram Auto Reply' },
				{ id: '2', name: 'Paused Automation' },
			],
		]);

		const result = await searchAutomations.call(context, 'PAUSED');

		expect(result.results).toEqual([{ name: 'Paused Automation', value: '2' }]);
	});

	it('returns an empty result set on an empty workspace (G4)', async () => {
		const { context } = fakeContext([[]]);

		const result = await searchAutomations.call(context);

		expect(result.results).toEqual([]);
	});

	it('follows next_cursor across pages while has_more is true', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			[{ id: '1', name: 'Page One Automation' }],
			[{ id: '2', name: 'Page Two Automation' }],
		]);

		const result = await searchAutomations.call(context);

		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(2);
		expect(httpRequestWithAuthentication).toHaveBeenNthCalledWith(
			2,
			'agentovaApi',
			expect.objectContaining({ qs: expect.objectContaining({ cursor: 'cursor-1' }) }),
		);
		expect(result.results).toEqual([
			{ name: 'Page One Automation', value: '1' },
			{ name: 'Page Two Automation', value: '2' },
		]);
	});
});
