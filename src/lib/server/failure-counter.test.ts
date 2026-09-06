import { describe, it, expect, vi } from 'vitest';
import { incrementFailureCount } from './failure-counter';

function fakeKv(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl: number }) => {
			store.set(key, value);
		}),
		store
	};
}

describe('incrementFailureCount', () => {
	it('starts a new day-bucketed key at 1', async () => {
		const kv = fakeKv();
		await incrementFailureCount(kv as never, 'sync_409_exhausted');

		const today = new Date().toISOString().slice(0, 10);
		expect(kv.put).toHaveBeenCalledWith(
			`failure:sync_409_exhausted:${today}`,
			'1',
			expect.objectContaining({ expirationTtl: expect.any(Number) })
		);
	});

	it('increments an existing count for the same class and day', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const kv = fakeKv({ [`failure:collection_key_rotated:${today}`]: '4' });

		await incrementFailureCount(kv as never, 'collection_key_rotated');

		expect(kv.put).toHaveBeenCalledWith(
			`failure:collection_key_rotated:${today}`,
			'5',
			expect.anything()
		);
	});

	it('keeps separate counts per failure class', async () => {
		const kv = fakeKv();
		await incrementFailureCount(kv as never, 'sync_409_exhausted');
		await incrementFailureCount(kv as never, 'collection_decrypt_failed');

		const today = new Date().toISOString().slice(0, 10);
		expect(kv.store.get(`failure:sync_409_exhausted:${today}`)).toBe('1');
		expect(kv.store.get(`failure:collection_decrypt_failed:${today}`)).toBe('1');
	});

	it('sets a retention TTL rather than keeping counts forever', async () => {
		const kv = fakeKv();
		await incrementFailureCount(kv as never, 'sync_409_exhausted');

		const [, , opts] = kv.put.mock.calls[0] as [string, string, { expirationTtl: number }];
		expect(opts.expirationTtl).toBeGreaterThan(0);
	});
});
