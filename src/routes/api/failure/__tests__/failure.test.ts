import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/api', () => ({
	apiError: (status: number, message: string) =>
		new Response(JSON.stringify({ error: message }), { status }),
	checkSameOrigin: (request: Request) => {
		const fetchSite = request.headers.get('sec-fetch-site');
		if (fetchSite && fetchSite !== 'same-origin') {
			return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
		}
		return null;
	}
}));

const checkRateLimit = vi.fn();
vi.mock('$lib/server/rate-limit', () => ({
	checkRateLimit: (...args: unknown[]) => checkRateLimit(...args)
}));

const incrementFailureCount = vi.fn();
vi.mock('$lib/server/failure-counter', () => ({
	incrementFailureCount: (...args: unknown[]) => incrementFailureCount(...args)
}));

const { POST } = await import('../+server');
const { FAILURE_CLASSES } = await import('$lib/report-failure');

type PostEvent = Parameters<typeof POST>[0];

function mockEvent(body: unknown, opts: { kv?: unknown } = {}): PostEvent {
	const request = new Request('https://example.com', {
		method: 'POST',
		headers: { 'sec-fetch-site': 'same-origin' },
		body: JSON.stringify(body)
	});
	return {
		request,
		platform: { env: { SHARE_KV: 'kv' in opts ? opts.kv : {} } },
		getClientAddress: () => '127.0.0.1'
	} as unknown as PostEvent;
}

describe('POST /api/failure', () => {
	beforeEach(() => {
		checkRateLimit.mockReset().mockResolvedValue(true);
		incrementFailureCount.mockReset().mockResolvedValue(undefined);
	});

	it('rejects cross-site requests', async () => {
		const req = new Request('https://example.com', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'cross-site' },
			body: JSON.stringify({ class: 'sync_409_exhausted' })
		});
		const res = await POST({
			request: req,
			platform: { env: { SHARE_KV: {} } },
			getClientAddress: () => '127.0.0.1'
		} as unknown as PostEvent);
		expect(res.status).toBe(403);
		expect(incrementFailureCount).not.toHaveBeenCalled();
	});

	it('no-ops when the KV binding is unavailable, rather than erroring', async () => {
		const res = await POST(mockEvent({ class: 'sync_409_exhausted' }, { kv: undefined }));
		expect(res.status).toBe(204);
		expect(incrementFailureCount).not.toHaveBeenCalled();
	});

	it('returns 429 once the rate limit is exceeded', async () => {
		checkRateLimit.mockResolvedValue(false);
		const res = await POST(mockEvent({ class: 'sync_409_exhausted' }));
		expect(res.status).toBe(429);
		expect(incrementFailureCount).not.toHaveBeenCalled();
	});

	it('rejects a class outside the known allowlist', async () => {
		const res = await POST(mockEvent({ class: 'literally_anything' }));
		expect(res.status).toBe(400);
		expect(incrementFailureCount).not.toHaveBeenCalled();
	});

	it('rejects a missing or non-string class', async () => {
		const res = await POST(mockEvent({}));
		expect(res.status).toBe(400);
		expect(incrementFailureCount).not.toHaveBeenCalled();
	});

	it('accepts every class $lib/report-failure actually reports, not just the ones this test happens to name', async () => {
		for (const cls of FAILURE_CLASSES) {
			const res = await POST(mockEvent({ class: cls }));
			expect(res.status).toBe(204);
		}
		expect(incrementFailureCount).toHaveBeenCalledTimes(FAILURE_CLASSES.length);
	});

	it('increments the counter for a known class', async () => {
		const kv = {};
		const res = await POST(mockEvent({ class: 'collection_key_rotated' }, { kv }));

		expect(res.status).toBe(204);
		expect(incrementFailureCount).toHaveBeenCalledWith(kv, 'collection_key_rotated');
	});

	it('returns 400 for unparseable JSON rather than throwing', async () => {
		const request = new Request('https://example.com', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'same-origin' },
			body: 'not json'
		});
		const res = await POST({
			request,
			platform: { env: { SHARE_KV: {} } },
			getClientAddress: () => '127.0.0.1'
		} as unknown as PostEvent);
		expect(res.status).toBe(400);
	});
});
