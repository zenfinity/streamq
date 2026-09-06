// Client sync engine (#101, part of the #79 sync epic). Wraps #100's
// encrypted-blob API in a merge-then-push loop that keeps this device's
// IndexedDB and the server's opaque blob converged, without ever letting the
// server see plaintext or this device's local (autoIncrement) ids.
import type { WatchlistItem, Provider } from './types';
import {
	getAllIncludingDeleted,
	replaceAll,
	setServices,
	getSyncDek,
	setSyncDek,
	clearSyncDek,
	clearUserPrivateKey,
	getMeta,
	setMeta,
	setClockOffsetMs,
	onMutation
} from './db';
import {
	serializeSyncSnapshot,
	deserializeAppState,
	applyPrefs,
	type AppStatePrefs,
	type BackupItem
} from './app-state';
import { ensureKeypair } from './keypair';
import { importDek, encryptBytesWithDek, decryptBytesWithDek } from './crypto';
import { gzip, gunzip } from './gzip';
import { reportFailure } from './report-failure';

const BLOB_URL = '/api/sync/blob';
const MAX_RETRIES = 5;
const DEBOUNCE_MS = 3000;
const LAST_PUSHED_AT_KEY = 'sync_last_pushed_at';
const SYNC_EMAIL_KEY = 'sync_email';

// ── Status broadcasting ──────────────────────────────────────────────────
// A plain listener list, not a Svelte $state store — this module has to stay
// importable from plain vitest (no Svelte plugin loaded there, same reason
// db.ts's mutation hook is a callback list rather than a rune; see #128).
// The Settings UI mirrors this into its own local $state via
// onSyncStatusChange() rather than importing reactive state directly.
export interface SyncStatus {
	status: 'idle' | 'syncing' | 'offline' | 'error';
	lastSyncedAt: string | null;
	error: string;
	email: string | null;
}

let status: SyncStatus = { status: 'idle', lastSyncedAt: null, error: '', email: null };
const statusListeners: ((s: SyncStatus) => void)[] = [];

function updateStatus(patch: Partial<SyncStatus>): void {
	status = { ...status, ...patch };
	for (const cb of statusListeners) cb(status);
}

export function getSyncStatus(): SyncStatus {
	return status;
}

/** Subscribes to status changes; immediately replays the current status so a
 * late subscriber isn't stuck showing stale defaults. Returns an unsubscribe. */
export function onSyncStatusChange(cb: (s: SyncStatus) => void): () => void {
	statusListeners.push(cb);
	cb(status);
	return () => {
		const i = statusListeners.indexOf(cb);
		if (i >= 0) statusListeners.splice(i, 1);
	};
}

// ── Enable / disable ─────────────────────────────────────────────────────
// Generating the DEK, wrapping it under the passphrase-derived key, and
// calling the signup/signin/recover endpoints is #103's (Sync settings UI)
// / sync-account-actions.ts's job — this module just needs somewhere to
// hand the already-generated DEK (and the email it belongs to, for display)
// once that flow has them.

export async function enableSyncWithDek(dekB64url: string, email: string): Promise<void> {
	const dek = await importDek(dekB64url, false);
	await setSyncDek(dek);
	await setMeta(SYNC_EMAIL_KEY, email);

	// Every path that unlocks the DEK — signup, signin, recovery — funnels
	// through here, which makes it the one place the collaboration keypair
	// (#189) can be established or restored for this device.
	//
	// Best-effort: a keypair failure must not fail sign-in. Personal sync does
	// not need it, and the collections UI calls ensureKeypair() again before it
	// needs one, so the cost of failing here is a retry later rather than an
	// account the user cannot get into.
	try {
		await ensureKeypair(dek);
	} catch {
		// Swallowed deliberately — see above.
	}

	updateStatus({ email, status: 'idle', error: '' });
}

export async function isSyncEnabled(): Promise<boolean> {
	return (await getSyncDek()) !== undefined;
}

export async function disableSync(): Promise<void> {
	await clearSyncDek();
	// The private key is account material, not queue data — leaving it behind
	// on a signed-out device would outlive the session that justified it.
	await clearUserPrivateKey();
	updateStatus({ email: null, status: 'idle', error: '', lastSyncedAt: null });
}

/** Restores the status (email, last-synced time) from IndexedDB on app
 * startup, so the UI shows the right thing before the first sync cycle of
 * this page load has run. No-op if sync was never enabled on this device. */
export async function restoreSyncState(): Promise<void> {
	const dek = await getSyncDek();
	if (!dek) return;
	const [email, lastSyncedAt] = await Promise.all([
		getMeta(SYNC_EMAIL_KEY),
		getMeta(LAST_PUSHED_AT_KEY)
	]);
	updateStatus({ email: email ?? null, lastSyncedAt: lastSyncedAt ?? null });
}

// ── Merge (the reviewable core) ──────────────────────────────────────────
// Base identity: [tmdb_id, media_type] — was also the whole merge key before
// #221. Field-group merge, not whole-item LWW: blind LWW would lose real
// work (device A marks something watched while device B updates its own
// copy of the same title — one edit silently wins and the other vanishes).
// Instead, whichever side has the newer updated_at wins every field *except*
// watched_seasons, which unions — monotonic and conflict-free, matching what
// the user meant by marking a season watched on either device.
//
// (The originating issue's merge table lists per-field LWW groups —
// watched_at/current_season/current_episode, queue_tag/title,
// TMDB-derived — down to individual fields. This app doesn't have
// current_season/current_episode as separate fields (that's #134,
// episode-level tracking, not shipped) — watched progress here is entirely
// `watched_seasons`. Folding every other field into one "newer wins" bundle
// is equivalent for the fields that actually exist, and simpler.)

type LocalItem = WatchlistItem;
type MergeCandidate = Omit<WatchlistItem, 'id'> & { id?: number };

function mergeOne(local: LocalItem | undefined, remote: BackupItem | undefined): MergeCandidate {
	if (!local) return { ...(remote as BackupItem) };
	if (!remote) return { ...local };

	const localTime = local.updated_at ?? local.added_at;
	const remoteTime = remote.updated_at ?? remote.added_at;
	const winner = remoteTime > localTime ? remote : local;

	const watched_seasons = Array.from(
		new Set([...(local.watched_seasons ?? []), ...(remote.watched_seasons ?? [])])
	).sort((a, b) => a - b);

	// added_at: keep whichever is earlier — it's "when this title first
	// entered the queue," which shouldn't move just because a later sync's
	// winner happened to have a different (e.g. defaulted) value.
	const added_at = local.added_at < remote.added_at ? local.added_at : remote.added_at;

	return { ...winner, id: local.id, added_at, watched_seasons };
}

function baseKey(item: { tmdb_id: number; media_type: 'movie' | 'tv' }): string {
	return `${item.media_type}:${item.tmdb_id}`;
}

function groupByBaseKey<T extends { tmdb_id: number; media_type: 'movie' | 'tv' }>(
	items: T[]
): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const k = baseKey(item);
		const group = map.get(k);
		if (group) group.push(item);
		else map.set(k, [item]);
	}
	return map;
}

/**
 * Merges this device's full local state (including tombstones) against a
 * remote snapshot just pulled from the server, producing the list to hand
 * to replaceAll(). Every local id is preserved; remote-only items get no id
 * so IndexedDB's key generator assigns one.
 *
 * Since #221, the store's uniqueness constraint is per list (queue_tag), not
 * global — the same title can legitimately have more than one row. That
 * can't just become the merge key, though: an ordinary list move (one device
 * changes queue_tag, the other hasn't synced yet) would then look like
 * "local added a new copy, remote kept the old one" — an edit misread as a
 * duplicate, which is exactly what #221's own scope note rules out ("manual
 * list reassignment should keep moving an item between lists, not
 * duplicating it").
 *
 * So this groups by the base identity (tmdb_id+media_type) first, same as
 * before #221, and only splits into per-queue_tag matching once a genuine
 * multi-list scenario already exists on at least one side (more than one
 * row sharing the base key) — that can only happen through a deliberate
 * multi-add (import, or adding the same title to a second list), never
 * through a single row's queue_tag changing. The common case — at most one
 * copy per side, which is still effectively all of today's usage — merges
 * exactly as it did before, with queue_tag as just another LWW-governed
 * field.
 *
 * Known gap: a move and an independent concurrent multi-list add for the
 * *same* title, on two devices, before either syncs, can still produce a
 * spurious extra row (there's no stable cross-device row id to disambiguate
 * "moved" from "added elsewhere" once both sides show 2+ copies). Rare, and
 * the fix is deleting the stray row, not lost data — a real per-row identity
 * would close this properly but is a materially bigger change than this
 * migration.
 */
export function mergeItems(local: LocalItem[], remote: BackupItem[]): MergeCandidate[] {
	const localByBase = groupByBaseKey(local);
	const remoteByBase = groupByBaseKey(remote);

	const merged: MergeCandidate[] = [];
	const baseKeys = new Set([...localByBase.keys(), ...remoteByBase.keys()]);
	for (const key of baseKeys) {
		const localGroup = localByBase.get(key) ?? [];
		const remoteGroup = remoteByBase.get(key) ?? [];

		if (localGroup.length <= 1 && remoteGroup.length <= 1) {
			merged.push(mergeOne(localGroup[0], remoteGroup[0]));
			continue;
		}

		const remoteByTag = new Map(remoteGroup.map((item) => [item.queue_tag ?? '', item]));
		const matchedTags = new Set<string>();
		for (const item of localGroup) {
			const tag = item.queue_tag ?? '';
			matchedTags.add(tag);
			merged.push(mergeOne(item, remoteByTag.get(tag)));
		}
		for (const item of remoteGroup) {
			const tag = item.queue_tag ?? '';
			if (matchedTags.has(tag)) continue;
			merged.push(mergeOne(undefined, item));
		}
	}
	return merged;
}

/**
 * Services: a single LWW register (db.ts stamps `services_updated_at` in
 * meta on every services write), not per-row tombstones — it's a small set
 * of ids, so one timestamp for "the set changed" is enough.
 */
function mergeServices(
	local: Provider[],
	localUpdatedAt: string | undefined,
	remote: Provider[] | undefined,
	remoteUpdatedAt: string | undefined
): Provider[] {
	if (!remote) return local;
	if (!localUpdatedAt) return remote;
	if (!remoteUpdatedAt) return local;
	return remoteUpdatedAt > localUpdatedAt ? remote : local;
}

/**
 * Prefs: no per-field timestamps are tracked, so this uses the coarser
 * signal already on hand — the sync blob's own server-side updated_at vs.
 * this device's own last successful push. If nothing has been pushed from
 * *this* device more recently than the blob's last write, the pulled prefs
 * are at least as fresh as what's local, so take them; otherwise keep local
 * (this device's own unpushed edits are newer than what it's about to pull).
 */
function mergePrefs(
	local: AppStatePrefs,
	remote: AppStatePrefs | undefined,
	remoteBlobUpdatedAt: string | undefined,
	lastPushedAt: string | undefined
): AppStatePrefs {
	if (!remote) return local;
	if (!remoteBlobUpdatedAt) return local;
	if (!lastPushedAt || remoteBlobUpdatedAt >= lastPushedAt) return { ...local, ...remote };
	return local;
}

// ── Push/pull cycle ───────────────────────────────────────────────────────

interface PulledBlob {
	version: number;
	bytes: ArrayBuffer | null;
	updatedAt: string | null;
}

async function getBlob(): Promise<PulledBlob> {
	const res = await fetch(BLOB_URL, { credentials: 'same-origin' });
	if (!res.ok) throw new Error(`Sync GET failed: ${res.status}`);
	const version = Number(res.headers.get('X-Sync-Version') ?? '0');
	const updatedAt = res.headers.get('X-Sync-Updated-At');
	const bytes = await res.arrayBuffer();
	return { version, bytes: bytes.byteLength > 0 ? bytes : null, updatedAt };
}

async function putBlob(
	body: ArrayBuffer,
	expectedVersion: number
): Promise<{ ok: true; version: number } | { ok: false; conflict: true }> {
	const res = await fetch(`${BLOB_URL}?version=${expectedVersion}`, {
		method: 'PUT',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/octet-stream' },
		body
	});
	const serverDate = res.headers.get('Date');
	if (serverDate) {
		const offset = new Date(serverDate).getTime() - Date.now();
		if (Number.isFinite(offset)) setClockOffsetMs(offset);
	}
	if (res.status === 409) return { ok: false, conflict: true };
	if (!res.ok) throw new Error(`Sync PUT failed: ${res.status}`);
	const json = (await res.json()) as { version: number };
	return { ok: true, version: json.version };
}

let syncing: Promise<void> | null = null;

/**
 * Runs one full pull -> merge -> push cycle, bounded-retrying on 409
 * (another device's write landed first: re-GET, re-merge, re-PUT). Calls
 * collapse into whichever cycle is already in flight rather than queuing —
 * a mutation that lands mid-sync will be picked up by the *next* trigger
 * (debounced-after-mutation fires again), not lost.
 */
export async function syncNow(): Promise<void> {
	if (syncing) return syncing;
	syncing = runSync().finally(() => {
		syncing = null;
	});
	return syncing;
}

async function runSync(): Promise<void> {
	const dek = await getSyncDek();
	if (!dek) return; // sync not enabled on this device

	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		updateStatus({ status: 'offline' });
		return;
	}

	updateStatus({ status: 'syncing' });
	try {
		await runSyncCycle(dek);
		updateStatus({ status: 'idle', error: '' });
	} catch (e) {
		updateStatus({ status: 'error', error: e instanceof Error ? e.message : 'Sync failed' });
		throw e;
	}
}

async function runSyncCycle(dek: CryptoKey): Promise<void> {
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const pulled = await getBlob();

		let remoteItems: BackupItem[] = [];
		let remotePrefs: AppStatePrefs | undefined;
		let remoteServices: Provider[] | undefined;
		if (pulled.bytes) {
			const plainGz = await decryptBytesWithDek(pulled.bytes, dek);
			const json = new TextDecoder().decode(await gunzip(plainGz));
			const parsed = deserializeAppState(JSON.parse(json));
			remoteItems = parsed.items;
			remotePrefs = parsed.prefs;
			remoteServices = parsed.services;
			// A well-formed-looking item from another of this account's own
			// devices failing validation is otherwise unknowable (#254) — this
			// isn't a hand-edited backup file, it's this same sync engine's own
			// output on a different device.
			if (parsed.rejectedItemCount > 0) reportFailure('backup_item_parse_rejected');
		}

		const [localSnapshot, localServicesUpdatedAt, lastPushedAt] = await Promise.all([
			serializeSyncSnapshot(),
			getMeta('services_updated_at'),
			getMeta(LAST_PUSHED_AT_KEY)
		]);

		const mergedItems = mergeItems(localSnapshot.items, remoteItems);
		const mergedServices = mergeServices(
			localSnapshot.services,
			localServicesUpdatedAt,
			remoteServices,
			pulled.updatedAt ?? undefined
		);
		const mergedPrefs = mergePrefs(
			localSnapshot.prefs,
			remotePrefs,
			pulled.updatedAt ?? undefined,
			lastPushedAt
		);

		// Apply locally first (silent — this is the engine's own write, not a
		// user mutation that should schedule another push), then re-read via
		// getAllIncludingDeleted so the push payload has real local ids
		// stripped (never leak a device-local autoIncrement id to the server).
		await Promise.all([
			replaceAll(mergedItems, { silent: true }),
			setServices(mergedServices, { silent: true })
		]);
		applyPrefs(mergedPrefs);

		const finalItems = (await getAllIncludingDeleted()).map(
			({ id: _id, ...rest }) => rest as BackupItem
		);
		const payload = JSON.stringify({
			version: localSnapshot.version,
			prefs: mergedPrefs,
			items: finalItems,
			services: mergedServices
		});
		const compressed = await gzip(new TextEncoder().encode(payload));
		const ciphertext = await encryptBytesWithDek(compressed, dek);

		const result = await putBlob(ciphertext, pulled.version);
		if (result.ok) {
			const now = new Date().toISOString();
			await setMeta(LAST_PUSHED_AT_KEY, now);
			updateStatus({ lastSyncedAt: now });
			return;
		}
		// 409: another write landed between our GET and PUT. Loop — re-GET,
		// re-merge (idempotent; merging the same local state again against a
		// newer remote is safe), re-PUT.
	}
	reportFailure('sync_409_exhausted');
	throw new Error('Sync failed after repeated version conflicts');
}

// ── Triggers ───────────────────────────────────────────────────────────────
// App load, visibilitychange, debounced-after-mutation, and a manual
// "Sync now" button (the button itself is #103's UI; syncNow() above is what
// it calls). No websockets, no Durable Objects, no delta sync — the blob is
// under a megabyte, whole-blob sync on these triggers is correct and boring.

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let triggersInitialized = false;

function scheduleDebouncedSync(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => void syncNow(), DEBOUNCE_MS);
}

/** Call once at app startup (e.g. +layout.svelte's onMount). Idempotent. */
export function initSyncTriggers(): void {
	if (triggersInitialized) return;
	triggersInitialized = true;

	void restoreSyncState().then(() => syncNow()); // app load

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void syncNow();
	});

	onMutation(scheduleDebouncedSync);
}
