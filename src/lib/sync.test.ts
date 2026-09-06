import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WatchlistItem } from './types';
import type { BackupItem } from './app-state';
import * as db from './db';
import { generateShareKey, encryptBytesWithDek, importDek } from './crypto';
import { gzip } from './gzip';
import { mergeItems, enableSyncWithDek, isSyncEnabled, disableSync, syncNow } from './sync';

const reportFailure = vi.fn();
vi.mock('./report-failure', () => ({
	reportFailure: (...args: unknown[]) => reportFailure(...args)
}));

// db.ts caches a single open IDBDatabase connection for the module's
// lifetime — clear both stores through the module's own functions between
// tests rather than deleting/recreating the database (see db.test.ts).
beforeEach(async () => {
	await db.replaceAll([]);
	await db.setServices([]);
	await disableSync();
	reportFailure.mockReset();
});

function makeItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
	return {
		id: 1,
		tmdb_id: 100,
		media_type: 'movie',
		title: 'Local Title',
		poster_path: null,
		overview: null,
		providers: [],
		runtime_minutes: 120,
		seasons: [],
		watched_seasons: [],
		added_at: '2024-01-01T00:00:00.000Z',
		watched_at: null,
		updated_at: '2024-01-01T00:00:00.000Z',
		...overrides
	};
}

function makeBackupItem(overrides: Partial<BackupItem> = {}): BackupItem {
	const { id: _id, ...rest } = makeItem(overrides);
	return rest;
}

describe('mergeItems', () => {
	it('remote wins the field bundle when it is newer, but keeps the local id', () => {
		const local = makeItem({ id: 5, title: 'Old Title', updated_at: '2024-01-01T00:00:00.000Z' });
		const remote = makeBackupItem({ title: 'New Title', updated_at: '2024-06-01T00:00:00.000Z' });

		const [merged] = mergeItems([local], [remote]);

		expect(merged.title).toBe('New Title');
		expect(merged.id).toBe(5);
	});

	it('local wins the field bundle when it is newer', () => {
		const local = makeItem({ id: 5, title: 'Newer Local', updated_at: '2024-06-01T00:00:00.000Z' });
		const remote = makeBackupItem({
			title: 'Stale Remote',
			updated_at: '2024-01-01T00:00:00.000Z'
		});

		const [merged] = mergeItems([local], [remote]);

		expect(merged.title).toBe('Newer Local');
		expect(merged.id).toBe(5);
	});

	it('unions watched_seasons regardless of which side wins the rest of the fields', () => {
		const local = makeItem({
			id: 5,
			watched_seasons: [1, 2],
			updated_at: '2024-01-01T00:00:00.000Z'
		});
		const remote = makeBackupItem({
			watched_seasons: [2, 3],
			updated_at: '2024-06-01T00:00:00.000Z' // remote wins the bundle
		});

		const [merged] = mergeItems([local], [remote]);

		expect(merged.watched_seasons).toEqual([1, 2, 3]);
	});

	it('keeps the earlier added_at regardless of which side wins', () => {
		const local = makeItem({
			id: 5,
			added_at: '2024-03-01T00:00:00.000Z',
			updated_at: '2024-01-01T00:00:00.000Z'
		});
		const remote = makeBackupItem({
			added_at: '2024-01-01T00:00:00.000Z', // earlier
			updated_at: '2024-06-01T00:00:00.000Z' // remote wins the bundle
		});

		const [merged] = mergeItems([local], [remote]);

		expect(merged.added_at).toBe('2024-01-01T00:00:00.000Z');
	});

	it('adds a remote-only item with no id, so the store assigns one', () => {
		const remote = makeBackupItem({ tmdb_id: 200, title: 'Remote Only' });

		const [merged] = mergeItems([], [remote]);

		expect(merged.id).toBeUndefined();
		expect(merged.title).toBe('Remote Only');
	});

	it('keeps a local-only item unchanged', () => {
		const local = makeItem({ id: 9, title: 'Local Only' });

		const [merged] = mergeItems([local], []);

		expect(merged.id).toBe(9);
		expect(merged.title).toBe('Local Only');
	});

	it('lets a newer remote deletion tombstone a locally-untouched item', () => {
		const local = makeItem({ id: 5, updated_at: '2024-01-01T00:00:00.000Z', deleted_at: null });
		const remote = makeBackupItem({
			updated_at: '2024-06-01T00:00:00.000Z',
			deleted_at: '2024-06-01T00:00:00.000Z'
		});

		const [merged] = mergeItems([local], [remote]);

		expect(merged.deleted_at).toBe('2024-06-01T00:00:00.000Z');
	});

	it('lets a newer local edit undelete an item the remote had tombstoned', () => {
		const local = makeItem({
			id: 5,
			title: 'Revived',
			updated_at: '2024-06-01T00:00:00.000Z',
			deleted_at: null
		});
		const remote = makeBackupItem({
			updated_at: '2024-01-01T00:00:00.000Z',
			deleted_at: '2024-01-01T00:00:00.000Z'
		});

		const [merged] = mergeItems([local], [remote]);

		expect(merged.deleted_at).toBeFalsy();
		expect(merged.title).toBe('Revived');
	});

	it('merges items keyed by [tmdb_id, media_type], not array position', () => {
		const local = [
			makeItem({ id: 1, tmdb_id: 10, media_type: 'movie', title: 'Movie A' }),
			makeItem({ id: 2, tmdb_id: 20, media_type: 'tv', title: 'Show B' })
		];
		const remote = [
			makeBackupItem({ tmdb_id: 10, media_type: 'tv', title: 'Different media type' })
		];

		const merged = mergeItems(local, remote);

		// tmdb_id 10 as a movie (local) and tmdb_id 10 as a tv show (remote) are
		// different keys — three rows out, not two.
		expect(merged).toHaveLength(3);
	});

	// #221 — the store's uniqueness went from global to per-list, so the
	// merge can no longer assume at most one local and one remote copy of a
	// title. These cover the two things that have to both be true at once:
	// a genuine multi-list scenario merges each copy independently, and an
	// ordinary list move (one copy per side, tag differs) still merges as a
	// single edited row rather than fanning out into two.
	describe('per-list titles (#221)', () => {
		it('merges two distinct list-copies of the same title independently, matched by queue_tag', () => {
			const local = [
				makeItem({
					id: 1,
					tmdb_id: 10,
					title: 'Local Horror copy',
					queue_tag: 'Horror',
					updated_at: '2024-01-01T00:00:00.000Z'
				}),
				makeItem({
					id: 2,
					tmdb_id: 10,
					title: 'Local Comedy copy',
					queue_tag: 'Comedy',
					updated_at: '2024-01-01T00:00:00.000Z'
				})
			];
			const remote = [
				makeBackupItem({
					tmdb_id: 10,
					title: 'Remote Horror copy (newer)',
					queue_tag: 'Horror',
					updated_at: '2024-06-01T00:00:00.000Z'
				}),
				makeBackupItem({
					tmdb_id: 10,
					title: 'Remote Comedy copy (newer)',
					queue_tag: 'Comedy',
					updated_at: '2024-06-01T00:00:00.000Z'
				})
			];

			const merged = mergeItems(local, remote);

			expect(merged).toHaveLength(2);
			const horror = merged.find((i) => i.queue_tag === 'Horror')!;
			const comedy = merged.find((i) => i.queue_tag === 'Comedy')!;
			// Each list-copy merged against its own remote counterpart (newer
			// wins the field bundle) and kept its own local id — not, say, one
			// copy's id landing on the other's fields.
			expect(horror.title).toBe('Remote Horror copy (newer)');
			expect(horror.id).toBe(1);
			expect(comedy.title).toBe('Remote Comedy copy (newer)');
			expect(comedy.id).toBe(2);
		});

		it('keeps a local-only second list-copy alongside a matched first copy', () => {
			const local = [
				makeItem({ id: 1, tmdb_id: 10, title: 'Shared copy', queue_tag: 'Horror' }),
				makeItem({ id: 2, tmdb_id: 10, title: 'Local-only copy', queue_tag: 'Comedy' })
			];
			const remote = [makeBackupItem({ tmdb_id: 10, title: 'Shared copy', queue_tag: 'Horror' })];

			const merged = mergeItems(local, remote);

			expect(merged).toHaveLength(2);
			expect(merged.find((i) => i.queue_tag === 'Comedy')!.id).toBe(2);
		});

		it('adopts a remote-only second list-copy alongside a matched first copy', () => {
			const local = [makeItem({ id: 1, tmdb_id: 10, title: 'Shared copy', queue_tag: 'Horror' })];
			const remote = [
				makeBackupItem({ tmdb_id: 10, title: 'Shared copy', queue_tag: 'Horror' }),
				makeBackupItem({ tmdb_id: 10, title: 'Remote-only copy', queue_tag: 'Comedy' })
			];

			const merged = mergeItems(local, remote);

			expect(merged).toHaveLength(2);
			const remoteOnly = merged.find((i) => i.queue_tag === 'Comedy')!;
			expect(remoteOnly.id).toBeUndefined(); // no local id — the store assigns one
		});

		// The critical regression this issue exists to prevent: without this,
		// a queue_tag change on one device (still unsynced on the other) would
		// misread as "local added a new copy, remote kept the old one,"
		// silently duplicating a title that was only ever moved once.
		it('merges an ordinary list move as one edited row, not a duplicate', () => {
			const local = [
				makeItem({
					id: 1,
					tmdb_id: 10,
					title: 'Moved locally',
					queue_tag: 'Comedy', // moved here from Horror
					updated_at: '2024-06-01T00:00:00.000Z' // the move is the newer edit
				})
			];
			const remote = [
				makeBackupItem({
					tmdb_id: 10,
					title: 'Stale remote copy',
					queue_tag: 'Horror', // remote hasn't learned about the move yet
					updated_at: '2024-01-01T00:00:00.000Z'
				})
			];

			const merged = mergeItems(local, remote);

			expect(merged).toHaveLength(1);
			expect(merged[0].id).toBe(1);
			expect(merged[0].queue_tag).toBe('Comedy'); // the newer edit (the move) wins
			expect(merged[0].title).toBe('Moved locally');
		});

		it('lets a newer remote move win over a stale local tag, still as one row', () => {
			const local = [
				makeItem({
					id: 1,
					tmdb_id: 10,
					queue_tag: 'Horror',
					updated_at: '2024-01-01T00:00:00.000Z'
				})
			];
			const remote = [
				makeBackupItem({
					tmdb_id: 10,
					queue_tag: 'Comedy',
					updated_at: '2024-06-01T00:00:00.000Z'
				})
			];

			const merged = mergeItems(local, remote);

			expect(merged).toHaveLength(1);
			expect(merged[0].queue_tag).toBe('Comedy');
		});
	});
});

describe('enableSyncWithDek / isSyncEnabled / disableSync', () => {
	beforeEach(async () => {
		await disableSync();
	});

	it('is disabled by default', async () => {
		expect(await isSyncEnabled()).toBe(false);
	});

	it('enables after importing a DEK, and disables again after clearing it', async () => {
		const dek = await generateShareKey();
		await enableSyncWithDek(dek, 'user@example.com');
		expect(await isSyncEnabled()).toBe(true);

		await disableSync();
		expect(await isSyncEnabled()).toBe(false);
	});
});

// ── Full push/pull cycle against a mocked /api/sync/blob ───────────────────

async function buildRemoteBlob(dekB64url: string, snapshot: unknown) {
	const key = await importDek(dekB64url, false);
	const compressed = await gzip(new TextEncoder().encode(JSON.stringify(snapshot)));
	return encryptBytesWithDek(compressed, key);
}

function mockFetchSequence(
	handlers: Array<(input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>>
) {
	let call = 0;
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const handler = handlers[Math.min(call, handlers.length - 1)];
		call++;
		return handler(input, init);
	});
}

describe('syncNow', () => {
	beforeEach(async () => {
		await disableSync();
		vi.restoreAllMocks();
	});

	it('does nothing when sync is not enabled (no DEK)', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		await syncNow();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('pushes local state as the first-ever sync (empty remote, version 0)', async () => {
		const dek = await generateShareKey();
		await enableSyncWithDek(dek, 'user@example.com');
		await db.addItem(makeBackupItem({ tmdb_id: 1 }) as never);

		let putUrl = '';
		vi.stubGlobal(
			'fetch',
			mockFetchSequence([
				async () => new Response(new ArrayBuffer(0), { headers: { 'X-Sync-Version': '0' } }),
				async (input) => {
					putUrl = String(input);
					return new Response(JSON.stringify({ version: 1 }), {
						status: 200,
						headers: { Date: new Date().toUTCString() }
					});
				}
			])
		);

		await syncNow();

		expect(putUrl).toContain('version=0');
	});

	it('pulls, merges, and applies a remote item alongside the local one', async () => {
		const dek = await generateShareKey();
		await enableSyncWithDek(dek, 'user@example.com');
		await db.addItem(makeBackupItem({ tmdb_id: 1, title: 'Local Item' }) as never);

		const remoteBlob = await buildRemoteBlob(dek, {
			version: 2,
			prefs: {},
			items: [makeBackupItem({ tmdb_id: 2, title: 'Remote Item' })],
			services: []
		});

		vi.stubGlobal(
			'fetch',
			mockFetchSequence([
				async () =>
					new Response(remoteBlob, {
						headers: { 'X-Sync-Version': '3', 'X-Sync-Updated-At': '2024-01-01T00:00:00.000Z' }
					}),
				async () =>
					new Response(JSON.stringify({ version: 4 }), {
						status: 200,
						headers: { Date: new Date().toUTCString() }
					})
			])
		);

		await syncNow();

		const all = await db.getAll();
		expect(all.map((i) => i.title).sort()).toEqual(['Local Item', 'Remote Item']);
	});

	it('retries once on a 409 version conflict, then succeeds', async () => {
		const dek = await generateShareKey();
		await enableSyncWithDek(dek, 'user@example.com');
		await db.addItem(makeBackupItem({ tmdb_id: 1 }) as never);

		let getCalls = 0;
		let putCalls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'GET') {
					getCalls++;
					return new Response(new ArrayBuffer(0), { headers: { 'X-Sync-Version': '0' } });
				}
				putCalls++;
				if (putCalls === 1) {
					return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
				}
				return new Response(JSON.stringify({ version: 1 }), {
					status: 200,
					headers: { Date: new Date().toUTCString() }
				});
			})
		);

		await expect(syncNow()).resolves.toBeUndefined();
		expect(getCalls).toBe(2);
		expect(putCalls).toBe(2);
	});

	it('reports sync_409_exhausted after MAX_RETRIES consecutive conflicts (#254)', async () => {
		const dek = await generateShareKey();
		await enableSyncWithDek(dek, 'user@example.com');
		await db.addItem(makeBackupItem({ tmdb_id: 1 }) as never);

		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'GET') {
					return new Response(new ArrayBuffer(0), { headers: { 'X-Sync-Version': '0' } });
				}
				return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
			})
		);

		await expect(syncNow()).rejects.toThrow('repeated version conflicts');
		expect(reportFailure).toHaveBeenCalledWith('sync_409_exhausted');
	});

	it('reports backup_item_parse_rejected when a pulled item fails validation (#254)', async () => {
		const dek = await generateShareKey();
		await enableSyncWithDek(dek, 'user@example.com');

		// A well-formed-looking item missing the one field parseBackupItem
		// requires (title) alongside a genuinely valid one — the invalid entry
		// should be silently dropped from the merge *and* reported, the valid
		// one should still make it through.
		const remoteBlob = await buildRemoteBlob(dek, {
			version: 2,
			prefs: {},
			items: [
				{ tmdb_id: 1, media_type: 'movie', title: 'Valid Item' },
				{ tmdb_id: 2, media_type: 'movie' }
			],
			services: []
		});

		vi.stubGlobal(
			'fetch',
			mockFetchSequence([
				async () => new Response(remoteBlob, { headers: { 'X-Sync-Version': '1' } }),
				async () =>
					new Response(JSON.stringify({ version: 2 }), {
						status: 200,
						headers: { Date: new Date().toUTCString() }
					})
			])
		);

		await syncNow();

		expect(reportFailure).toHaveBeenCalledWith('backup_item_parse_rejected');
		const all = await db.getAll();
		expect(all.map((i) => i.title)).toEqual(['Valid Item']);
	});
});
