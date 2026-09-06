import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportFailure } from './report-failure';

describe('reportFailure', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
	});

	it('POSTs the failure class to /api/failure', () => {
		reportFailure('sync_409_exhausted');

		expect(fetch).toHaveBeenCalledWith(
			'/api/failure',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ class: 'sync_409_exhausted' }),
				keepalive: true
			})
		);
	});

	it('never throws when the network request rejects', () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
		expect(() => reportFailure('collection_decrypt_failed')).not.toThrow();
	});

	it('never throws when fetch itself is unavailable', () => {
		vi.stubGlobal('fetch', undefined);
		expect(() => reportFailure('collection_decrypt_failed')).not.toThrow();
	});
});
