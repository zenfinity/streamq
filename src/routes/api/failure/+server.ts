import type { RequestHandler } from './$types';
import { apiError, checkSameOrigin } from '$lib/server/api';
import { checkRateLimit } from '$lib/server/rate-limit';
import { incrementFailureCount } from '$lib/server/failure-counter';

// The exact set of classes callers may report — an arbitrary-string sink
// would turn this into a free-form write endpoint, which defeats the whole
// "content-free counter" point of #254. Duplicated rather than imported from
// $lib/report-failure: that module is client-facing (it calls fetch()) and
// has no reason to be pulled into the server bundle just for this list.
const KNOWN_CLASSES = new Set([
	'sync_409_exhausted',
	'backup_item_parse_rejected',
	'collection_sync_409_exhausted',
	'collection_key_rotated',
	'collection_dek_mismatch',
	'collection_decrypt_failed'
]);

// Generous relative to how often any single client can actually trip one of
// these — every reporting call site is already bounded by its own retry loop
// or a debounced sync trigger — so this exists to cap abuse, not to shave
// real signal off an ongoing incident.
const RATE_LIMIT = { max: 30, windowSeconds: 60 };

/**
 * Increments a per-day KV counter for one failure class. No user id, no
 * collection id, no payload beyond the class name itself — see the module
 * comment on $lib/report-failure for why this exists and what it
 * deliberately does not collect. Unauthenticated by design: the failures
 * being counted (a 409-retry loop exhausting, a collection blob refusing to
 * decrypt) can happen to a client whose own session is part of what's
 * broken, and the class name alone carries no exploitable signal. Reuses
 * SHARE_KV rather than a dedicated binding — same namespace this endpoint
 * already needs for rate-limiting, and one fewer piece of infrastructure to
 * provision and keep working.
 */
export const POST: RequestHandler = async ({ request, platform, getClientAddress }) => {
	const originError = checkSameOrigin(request);
	if (originError) return originError;

	const kv = platform?.env?.SHARE_KV;
	if (!kv) return new Response(null, { status: 204 });

	const allowed = await checkRateLimit(
		kv,
		`failure-report:${getClientAddress()}`,
		RATE_LIMIT.max,
		RATE_LIMIT.windowSeconds
	);
	if (!allowed) return apiError(429, 'Too many requests');

	const body = (await request.json().catch(() => null)) as { class?: unknown } | null;
	const failureClass = typeof body?.class === 'string' ? body.class : '';
	if (!KNOWN_CLASSES.has(failureClass)) return apiError(400, 'Unknown failure class');

	await incrementFailureCount(kv, failureClass);

	return new Response(null, { status: 204 });
};
