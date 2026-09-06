import type { KVNamespace } from '@cloudflare/workers-types';

// Non-atomic read-modify-write, same tradeoff as rate-limit.ts's counter: a
// burst of concurrent requests can each read the same pre-increment value
// and undercount by a few. Acceptable here for the same reason — these are
// occasional sync/crypto failures (a retry loop exhausting, a decrypt
// failing), not a high-frequency event where a handful of lost increments
// would meaningfully distort the signal.
const RETENTION_DAYS = 90;

/** One key per failure class per UTC day — "this failure class happened N
 *  times today" is literally how #254 frames the ask, and day-bucketing
 *  keeps a single hot key from being written by every failure forever. */
export async function incrementFailureCount(kv: KVNamespace, failureClass: string): Promise<void> {
	const day = new Date().toISOString().slice(0, 10);
	const key = `failure:${failureClass}:${day}`;
	const current = Number((await kv.get(key)) ?? '0');
	await kv.put(key, String(current + 1), { expirationTtl: RETENTION_DAYS * 24 * 60 * 60 });
}
