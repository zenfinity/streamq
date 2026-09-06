// Collection blob merge and sync (#188). Parallels sync.ts's personal-queue
// engine but for a shared, multi-writer collection: same field-group LWW
// shape (mergeOne's pattern, not reused directly — see the note on #188 for
// why it wasn't a drop-in call), same version-precondition PUT/409/retry
// cycle, same untrusted-payload parsing via app-state.ts's parseBackupItem.
//
// Deliberately holds no persistent local IndexedDB store for collection
// items — every mutation pulls the latest blob, merges, applies the caller's
// change, and pushes. That trades offline editing of a shared collection
// (not yet supported) for a materially smaller v1: no schema migration, no
// second tombstone-and-replace machinery to keep in sync with sync.ts's, and
// merge correctness that's easy to state because there is no local cache to
// go stale. Worth revisiting if offline collection editing is ever wanted.
import { itemKey, type WatchlistItem } from './types';
import { parseBackupItemPublic, type BackupItem } from './app-state';
import { decryptBytesWithDek, encryptBytesWithDek } from './crypto';
import { gzip, gunzip } from './gzip';
import { validateIsoDate } from './validate';
import { reportFailure } from './report-failure';

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 200;

function collectionBlobUrl(collectionId: string): string {
	return `/api/collections/${encodeURIComponent(collectionId)}/blob`;
}

// ── Merge (the reviewable core) ─────────────────────────────────────────

/**
 * Per-account watch marks, merged as a union over account ids with
 * last-write-wins *within* each account's own entry. This is the fix for the
 * bug whole-item LWW would ship with: two members marking watched between
 * syncs would otherwise have the loser's entire map replace the winner's,
 * silently erasing whichever mark synced second.
 */
export function mergeCollectionWatch(
	local: Record<string, string> | undefined,
	remote: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!local) return remote;
	if (!remote) return local;
	const merged: Record<string, string> = Object.create(null);
	for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
		const l = local[key];
		const r = remote[key];
		merged[key] = !l ? r : !r ? l : r > l ? r : l;
	}
	return merged;
}

type MergeCandidate = BackupItem;

/**
 * Same field-group shape as sync.ts's mergeOne: whichever side has the newer
 * `updated_at` wins every field except the two that need their own merge
 * rule. `watched_seasons` already unions (shared with personal sync).
 * `watch` unions per-account (above). `added_by_account_id` is attribution,
 * not an edit — it is set once at creation and should never move just
 * because a later edit happened to originate from someone else's device, so
 * it is kept from whichever side already has it rather than following the
 * LWW winner.
 */
export function mergeCollectionItem(
	local: MergeCandidate | undefined,
	remote: MergeCandidate | undefined
): MergeCandidate {
	if (!local) return { ...(remote as MergeCandidate) };
	if (!remote) return { ...local };

	const localTime = local.updated_at ?? local.added_at;
	const remoteTime = remote.updated_at ?? remote.added_at;
	const winner = remoteTime > localTime ? remote : local;

	const watched_seasons = Array.from(
		new Set([...(local.watched_seasons ?? []), ...(remote.watched_seasons ?? [])])
	).sort((a, b) => a - b);

	const added_at = local.added_at < remote.added_at ? local.added_at : remote.added_at;

	const watch = mergeCollectionWatch(local.watch, remote.watch);
	const added_by_account_id = local.added_by_account_id ?? remote.added_by_account_id ?? null;

	return {
		...winner,
		added_at,
		watched_seasons,
		...(watch ? { watch } : {}),
		added_by_account_id
	};
}

/** Key-union merge, same shape as sync.ts's mergeItems but with no local id
 * to preserve — a collection item's identity is entirely tmdb_id+media_type. */
export function mergeCollectionItems(
	local: MergeCandidate[],
	remote: MergeCandidate[]
): MergeCandidate[] {
	const localByKey = new Map<string, MergeCandidate>();
	for (const item of local) localByKey.set(itemKey(item), item);

	const remoteByKey = new Map<string, MergeCandidate>();
	for (const item of remote) remoteByKey.set(itemKey(item), item);

	const keys = new Set([...localByKey.keys(), ...remoteByKey.keys()]);
	const merged: MergeCandidate[] = [];
	for (const key of keys) {
		merged.push(mergeCollectionItem(localByKey.get(key), remoteByKey.get(key)));
	}
	return merged;
}

// ── Ballots (#210 — ranked-choice voting) ─────────────────────────────────
// A member's ballot is one ordered list of up to 5 item keys (1st choice
// first), not a per-item field — unlike `watch`, ranking one title isn't
// independent of ranking another; it's a member's whole ordered list. Lives
// as a sibling of `items` on the collection blob, keyed by account id, same
// per-account map shape as `watch` — but each entry carries its own
// `updatedAt` (unlike `watch`, whose *value* already is a timestamp) since
// an array has no ordering signal to compare across two devices' copies.

export const MAX_BALLOT_SIZE = 5;

export interface BallotEntry {
	/** Ordered item keys (`media_type:tmdb_id`), index 0 = 1st choice. */
	items: string[];
	updatedAt: string;
}

/**
 * Per-account ballots, merged the same way mergeCollectionWatch merges watch
 * marks: whichever side's entry for that account is newer wins *whole* —
 * replacing the other side's ballot outright, not merging item-by-item,
 * since "swap my 2nd and 3rd choice" isn't expressible as a per-item diff.
 */
export function mergeCollectionBallots(
	local: Record<string, BallotEntry>,
	remote: Record<string, BallotEntry>
): Record<string, BallotEntry> {
	const merged: Record<string, BallotEntry> = Object.create(null);
	for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
		const l = local[key];
		const r = remote[key];
		merged[key] = !l ? r : !r ? l : r.updatedAt > l.updatedAt ? r : l;
	}
	return merged;
}

const ITEM_KEY_RE = /^(movie|tv):\d+$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_BALLOT_ENTRIES = 50;

/** Same untrusted-payload posture as app-state.ts's parseWatch — a
 * collection blob is written by other members' devices. */
function parseBallotEntry(raw: unknown): BallotEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const e = raw as Record<string, unknown>;
	const updatedAt = validateIsoDate(e.updatedAt);
	if (!updatedAt || !Array.isArray(e.items)) return null;

	const seen = new Set<string>();
	const items: string[] = [];
	for (const v of e.items) {
		if (items.length >= MAX_BALLOT_SIZE) break;
		if (typeof v !== 'string' || !ITEM_KEY_RE.test(v) || seen.has(v)) continue;
		seen.add(v);
		items.push(v);
	}
	return { items, updatedAt };
}

function parseBallots(raw: unknown): Record<string, BallotEntry> {
	const out: Record<string, BallotEntry> = Object.create(null);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	let count = 0;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (count >= MAX_BALLOT_ENTRIES) break;
		if (DANGEROUS_KEYS.has(key) || !ACCOUNT_ID_RE.test(key)) continue;
		const entry = parseBallotEntry(value);
		if (!entry) continue;
		out[key] = entry;
		count++;
	}
	return out;
}

// ── Pull / push ────────────────────────────────────────────────────────────

interface PulledCollectionBlob {
	version: number;
	dekVersion: number;
	items: MergeCandidate[];
	ballots: Record<string, BallotEntry>;
}

/**
 * A stale-key 409 ("Key rotated") is distinct from a version conflict: no
 * amount of retrying the same push will fix it, because the ciphertext is
 * encrypted under a DEK generation the server has moved past. The caller
 * needs to re-fetch its wrapped key (see collection-actions.ts) before
 * anything here can succeed again.
 */
export class CollectionKeyRotatedError extends Error {
	constructor() {
		super('This collection’s key changed — refresh your membership and try again.');
		this.name = 'CollectionKeyRotatedError';
	}
}

/**
 * `expectedDekVersion` — the caller's own memberDekVersion, i.e. the
 * generation its `dek` was actually unwrapped under — lets this function
 * tell "encrypted under a generation I don't hold" from "corrupt" (#254)
 * *before* attempting to decrypt, the same distinction the PUT side already
 * makes server-side (blob/+server.ts's memberDekVersion/collectionDekVersion
 * check). Without it, a partial key rotation surfaces as a generic decrypt
 * failure indistinguishable from real corruption — the exact ambiguity
 * X-Collection-Dek-Version exists to resolve. Optional and skipped when
 * omitted: a caller with no independent notion of its own generation (there
 * isn't one currently) simply attempts decrypt and reports whatever
 * happens as collection_decrypt_failed.
 */
async function pullCollectionBlob(
	collectionId: string,
	dek: CryptoKey,
	expectedDekVersion?: number
): Promise<PulledCollectionBlob> {
	const res = await fetch(collectionBlobUrl(collectionId), { credentials: 'same-origin' });
	if (!res.ok) throw new Error(`Collection sync GET failed: ${res.status}`);

	const version = Number(res.headers.get('X-Sync-Version') ?? '0');
	const dekVersion = Number(res.headers.get('X-Collection-Dek-Version') ?? '1');
	if (expectedDekVersion !== undefined && dekVersion !== expectedDekVersion) {
		reportFailure('collection_dek_mismatch');
		throw new CollectionKeyRotatedError();
	}

	const bytes = await res.arrayBuffer();
	if (bytes.byteLength === 0) return { version, dekVersion, items: [], ballots: {} };

	let json: string;
	try {
		const plainGz = await decryptBytesWithDek(bytes, dek);
		json = new TextDecoder().decode(await gunzip(plainGz));
	} catch (e) {
		reportFailure('collection_decrypt_failed');
		throw e;
	}
	const parsed = JSON.parse(json) as { items?: unknown[]; ballots?: unknown };

	// Every item is re-validated through the same untrusted-payload allowlist
	// as a personal backup, not merely JSON.parse'd and trusted — a collection
	// blob is written by other people's devices, which makes it at least as
	// untrusted as a backup file someone hands you.
	const rawItems = parsed.items ?? [];
	const items = rawItems.map(parseBackupItemPublic).filter((i): i is BackupItem => i !== null);
	// Unlike a personal sync pull (see sync.ts), every caller of this
	// function is sync, never local-file import — a shared collection has no
	// import/export path — so this is unconditionally worth reporting (#254).
	if (items.length < rawItems.length) reportFailure('backup_item_parse_rejected');
	const ballots = parseBallots(parsed.ballots);

	return { version, dekVersion, items, ballots };
}

// dekVersion is not sent — the server derives it from the caller's own
// membership row (see the PUT handler), which is also what makes a stale-key
// push fail with the rotated-key 409 rather than silently succeeding under a
// generation nobody else can open.
async function pushCollectionBlob(
	collectionId: string,
	dek: CryptoKey,
	items: MergeCandidate[],
	ballots: Record<string, BallotEntry>,
	expectedVersion: number
): Promise<{ ok: true; version: number } | { ok: false; conflict: true }> {
	const payload = JSON.stringify({ items, ballots });
	const compressed = await gzip(new TextEncoder().encode(payload));
	const ciphertext = await encryptBytesWithDek(compressed, dek);

	const res = await fetch(`${collectionBlobUrl(collectionId)}?version=${expectedVersion}`, {
		method: 'PUT',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/octet-stream' },
		body: ciphertext
	});
	if (res.status === 409) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		if (/rotated/i.test(body.error ?? '')) {
			reportFailure('collection_key_rotated');
			throw new CollectionKeyRotatedError();
		}
		return { ok: false, conflict: true };
	}
	if (!res.ok) throw new Error(`Collection sync PUT failed: ${res.status}`);
	const json = (await res.json()) as { version: number };
	return { ok: true, version: json.version };
}

function jitteredBackoff(attempt: number): Promise<void> {
	// Doubling backoff plus randomised jitter — two members' clients hitting a
	// 409 at the same instant and retrying on the exact same timer would just
	// collide again. Full jitter (not merely "add noise to the interval")
	// keeps a burst of simultaneous writers from staying in lockstep at all,
	// which a fixed or lightly-jittered backoff can still fall into.
	const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, 4000);
	const delay = Math.random() * capped;
	return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Reads the latest state of a collection without pushing anything — used to
 * populate a view when it opens. Returns items and ballots together (one
 * blob pull covers both) since every surface that renders shared items also
 * needs ballots to show ranks and the group tally.
 */
export async function fetchCollectionState(
	collectionId: string,
	dek: CryptoKey,
	expectedDekVersion?: number
): Promise<{ items: MergeCandidate[]; ballots: Record<string, BallotEntry> }> {
	const { items, ballots } = await pullCollectionBlob(collectionId, dek, expectedDekVersion);
	return { items, ballots };
}

/**
 * Runs one full pull -> merge -> mutate -> push cycle for a shared
 * collection, retrying on version conflict with jittered backoff.
 *
 * `localItems` is the caller's last-known snapshot (typically what
 * `fetchCollectionItems` returned, still held in the view's own state — see
 * the module note on why there is no persistent local cache to read this
 * from instead). `applyMutation` receives the freshly merged base — local
 * merged against whatever landed on the server since — and returns the next
 * state, e.g. with one title added, one watch mark toggled, or one title
 * soft-deleted. Applying the mutation *after* merging, on every attempt, is
 * what makes retry safe: a losing attempt's mutation is never dropped, it is
 * simply re-applied on top of a fresher base.
 */
export async function syncCollectionItems(
	collectionId: string,
	dek: CryptoKey,
	localItems: MergeCandidate[],
	applyMutation: (merged: MergeCandidate[]) => MergeCandidate[],
	expectedDekVersion?: number
): Promise<MergeCandidate[]> {
	let current = localItems;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const pulled = await pullCollectionBlob(collectionId, dek, expectedDekVersion);
		const merged = mergeCollectionItems(current, pulled.items);
		const next = applyMutation(merged);

		// Ballots aren't touched by an item mutation — relay forward whatever
		// was just pulled rather than merging against a stale local copy this
		// caller was never tracking in the first place.
		const result = await pushCollectionBlob(
			collectionId,
			dek,
			next,
			pulled.ballots,
			pulled.version
		);
		if (result.ok) return next;

		// 409: someone else's write landed first. Carry `next` forward as the
		// new merge base so this attempt's mutation survives the retry instead
		// of being silently lost.
		current = next;
		await jitteredBackoff(attempt);
	}
	reportFailure('collection_sync_409_exhausted');
	throw new Error('Could not sync this collection after repeated conflicts.');
}

/**
 * Mirrors syncCollectionItems for the other half of the blob: pulls, merges
 * ballots against `localBallots`, applies the caller's mutation, and pushes
 * — relaying `items` straight through unchanged, same reasoning as above but
 * flipped. One low-level pull/push pair backs both functions; which field
 * gets merged-and-mutated versus relayed-through is the only difference.
 */
export async function syncCollectionBallots(
	collectionId: string,
	dek: CryptoKey,
	localBallots: Record<string, BallotEntry>,
	applyMutation: (merged: Record<string, BallotEntry>) => Record<string, BallotEntry>,
	expectedDekVersion?: number
): Promise<Record<string, BallotEntry>> {
	let current = localBallots;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const pulled = await pullCollectionBlob(collectionId, dek, expectedDekVersion);
		const merged = mergeCollectionBallots(current, pulled.ballots);
		const next = applyMutation(merged);

		const result = await pushCollectionBlob(collectionId, dek, pulled.items, next, pulled.version);
		if (result.ok) return next;

		current = next;
		await jitteredBackoff(attempt);
	}
	reportFailure('collection_sync_409_exhausted');
	throw new Error('Could not sync this collection after repeated conflicts.');
}

/** Re-exported for callers that only need the WatchlistItem-shaped type
 * without pulling in app-state.ts's whole surface. */
export type { WatchlistItem };
export type { BackupItem as CollectionItem };
