// Minimal failure observability (#254) — content-free failure *counters*,
// not analytics. No user id, no collection id, no titles, nothing that could
// deanonymize: just "this failure class happened" for the handful of sync/
// crypto paths that are silent by design (the server never holds decryption
// capability, so a client-visible failure is often the *only* signal that
// exists). Deliberately scoped to sync/crypto only — the other ~70 `catch {}`
// blocks in this codebase are local-only (e.g. a localStorage write failing
// under Safari private mode) and aren't worth a network call.
export const FAILURE_CLASSES = [
	// Personal sync gave up after MAX_RETRIES consecutive 409s.
	'sync_409_exhausted',
	// A synced item/prefs/services payload contained at least one entry
	// parseBackupItem rejected outright, despite arriving from a source
	// (another of the user's own devices) that should only ever produce
	// well-formed payloads.
	'backup_item_parse_rejected',
	// Same as sync_409_exhausted, for a shared collection's item/ballot sync.
	'collection_sync_409_exhausted',
	// The PUT was refused because this client's wrapped key is behind the
	// collection's current generation (removeMemberAndRotate ran since this
	// client last refreshed its membership).
	'collection_key_rotated',
	// The GET response's X-Collection-Dek-Version didn't match this client's
	// own memberDekVersion *before* attempting to decrypt — caught proactively
	// via the header, not via a failed decrypt (see collection-sync.ts).
	'collection_dek_mismatch',
	// Decrypt or gunzip/JSON-parse failed on a collection blob whose
	// dek version *did* match what this client expected — genuine corruption,
	// not a key-generation lag.
	'collection_decrypt_failed'
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Fire-and-forget: never throws, never awaited by callers, and a failure to
 * report is itself silent — telemetry must not become one more thing that
 * can break a sync cycle. `keepalive` lets the request outlive a page
 * navigation that a thrown sync error might trigger (e.g. a redirect to an
 * error state).
 */
export function reportFailure(failureClass: FailureClass): void {
	try {
		void fetch('/api/failure', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ class: failureClass }),
			keepalive: true
		}).catch(() => {});
	} catch {
		// Best-effort; see module comment.
	}
}
