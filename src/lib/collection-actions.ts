// Client actions for collaborative Collections (#189), following the
// established `*ActionDeps` pattern (see queue-actions.ts / sync-account-
// actions.ts): plain async functions, injected setBusy/setError callbacks,
// no runes — the calling component owns all reactive state.
import {
	generateShareKey,
	wrapKeyForMember,
	unwrapKeyForMember,
	encryptBytesWithDek,
	decryptBytesWithDek,
	importDek
} from './crypto';
import { b64urlEncode } from './base64url';
import { getSyncDek, getUserPrivateKey, removeItem } from './db';
import { ensureKeypair } from './keypair';
import { throwIfNotOk } from './http';
import {
	syncCollectionItems,
	syncCollectionBallots,
	fetchCollectionState,
	MAX_BALLOT_SIZE,
	type CollectionItem,
	type BallotEntry
} from './collection-sync';
import { itemKey, type WatchlistItem } from './types';
import { getSyncStatus } from './sync';

export interface CollectionActionDeps {
	setBusy: (busy: boolean) => void;
	setError: (error: string) => void;
}

export interface SharedCollection {
	id: string;
	name: string;
	/** Manually-picked override, synced across every member/device (#237).
	 *  Null means no override — see queue-colors.ts's sharedListColor for the
	 *  deterministic-hash fallback used in that case. */
	color: string | null;
	ownerUserId: string;
	role: 'owner' | 'member';
	wrappedKey: string;
	dekVersion: number;
	memberDekVersion: number;
}

export interface CollectionMember {
	userId: string;
	email: string;
	role: 'owner' | 'member';
	dekVersion: number;
	publicKey: string | null;
	joinedAt: string;
}

async function requirePersonalDek(): Promise<CryptoKey> {
	const dek = await getSyncDek();
	if (!dek) throw new Error('Turn on sync before using shared collections.');
	return dek;
}

/**
 * Unwraps a collection's DEK using this account's private key. Every wrapped
 * key — whether minted at creation, at invite redemption, or by a rotation —
 * is RSA-wrapped under the holder's public key, so one path covers all three.
 */
export async function openCollectionKey(wrappedKey: string): Promise<string> {
	const priv = await getUserPrivateKey();
	if (!priv) throw new Error('This device is missing your account key. Sign in again.');
	return unwrapKeyForMember(wrappedKey, priv);
}

export async function listCollections(deps: CollectionActionDeps): Promise<SharedCollection[]> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const res = await fetch('/api/collections');
		await throwIfNotOk(res);
		return ((await res.json()) as { collections: SharedCollection[] }).collections;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not load shared collections.');
		return [];
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Creates a shared collection. The DEK is generated here and wrapped under
 * this account's own public key — the same format every other member's copy
 * uses, so nothing about the creator's copy is special.
 */
export async function createCollection(
	name: string,
	deps: CollectionActionDeps
): Promise<SharedCollection | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const personalDek = await requirePersonalDek();
		const publicKey = await ensureKeypair(personalDek);

		const dek = await generateShareKey();
		const wrappedKey = await wrapKeyForMember(dek, publicKey);

		const res = await fetch('/api/collections', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, wrappedKey })
		});
		await throwIfNotOk(res);
		return (await res.json()) as SharedCollection;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not create the collection.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Mints an invite link. The Collection DEK travels in the URL *fragment*, so
 * it never reaches the server — same construction as share links (#96). The
 * token identifies the invite; the fragment carries the key that makes it
 * useful, and the two are only ever combined in a recipient's browser.
 */
export async function createInvite(
	collection: SharedCollection,
	origin: string,
	deps: CollectionActionDeps
): Promise<string | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const dek = await openCollectionKey(collection.wrappedKey);

		const res = await fetch(`/api/collections/${collection.id}/invites`, { method: 'POST' });
		await throwIfNotOk(res);
		const { token } = (await res.json()) as { token: string };

		return `${origin}/lists/join/${token}#${dek}`;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not create an invite link.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

export interface OutstandingInvite {
	id: string;
	createdAt: string;
	expiresAt: string;
}

/** Lists this collection's outstanding (unclaimed, unrevoked, unexpired)
 *  invites, so the owner can see — and revoke — a link before it's used. */
export async function listInvites(
	collectionId: string,
	deps: CollectionActionDeps
): Promise<OutstandingInvite[]> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const res = await fetch(`/api/collections/${collectionId}/invites`);
		await throwIfNotOk(res);
		return ((await res.json()) as { invites: OutstandingInvite[] }).invites;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not load invites.');
		return [];
	} finally {
		deps.setBusy(false);
	}
}

export async function revokeInvite(
	collectionId: string,
	inviteId: string,
	deps: CollectionActionDeps
): Promise<boolean> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const res = await fetch(
			`/api/collections/${collectionId}/invites?id=${encodeURIComponent(inviteId)}`,
			{ method: 'DELETE' }
		);
		await throwIfNotOk(res);
		return true;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not revoke the invite.');
		return false;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Redeems an invite. `dek` comes from the link's fragment — the caller reads
 * it from `location.hash`, so it is never sent anywhere; only this account's
 * own wrapped copy is.
 */
export async function joinCollection(
	token: string,
	dek: string,
	deps: CollectionActionDeps
): Promise<{ collectionId: string; alreadyMember?: boolean } | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const personalDek = await requirePersonalDek();
		const publicKey = await ensureKeypair(personalDek);
		const wrappedKey = await wrapKeyForMember(dek, publicKey);

		const res = await fetch(`/api/collections/invites/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ wrappedKey })
		});
		await throwIfNotOk(res);
		return (await res.json()) as { collectionId: string; alreadyMember?: boolean };
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not join the collection.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

export async function listMembers(
	collectionId: string,
	deps: CollectionActionDeps
): Promise<CollectionMember[]> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const res = await fetch(`/api/collections/${collectionId}/members`);
		await throwIfNotOk(res);
		return ((await res.json()) as { members: CollectionMember[] }).members;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not load members.');
		return [];
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Removes a member and rotates the Collection DEK.
 *
 * Deleting a member's row revokes nothing on its own — symmetric group keys
 * have no partial revocation, and a removed member may have kept the raw DEK.
 * So removal means a new key, the payload re-encrypted under it, and a fresh
 * wrapped key for everyone who remains.
 *
 * All of that is assembled here and posted as one request, which the server
 * applies in a single batch. That is what makes an interrupted rotation
 * harmless: nothing is written until everything is ready, so a closed tab
 * midway leaves the collection exactly as it was rather than re-encrypted
 * under a key some members have no copy of.
 */
export async function removeMemberAndRotate(
	collection: SharedCollection,
	removeUserId: string,
	deps: CollectionActionDeps
): Promise<boolean> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const members = await listMembers(collection.id, {
			setBusy: () => {},
			setError: () => {}
		});
		const remaining = members.filter((m) => m.userId !== removeUserId);

		// Refuse rather than silently drop anyone: a member with no published
		// public key cannot be re-keyed, and rotating without them would lock
		// them out permanently with no way back.
		const unkeyed = remaining.filter((m) => !m.publicKey);
		if (unkeyed.length) {
			throw new Error(
				`${unkeyed.map((m) => m.email).join(', ')} hasn't signed in since sharing was added, so they can't be re-keyed yet. Ask them to open Queuest, then try again.`
			);
		}

		const oldDek = await openCollectionKey(collection.wrappedKey);
		const newDek = await generateShareKey();

		// Re-encrypt the payload under the new key. An empty collection has no
		// blob yet; a minimal ciphertext still needs writing so the stored
		// generation matches the members' new keys.
		const current = await fetch(`/api/collections/${collection.id}/blob`);
		await throwIfNotOk(current);
		const currentBytes = await current.arrayBuffer();

		const oldKey = await importDek(oldDek, false);
		const newKey = await importDek(newDek, false);
		const plaintext = currentBytes.byteLength
			? await decryptBytesWithDek(currentBytes, oldKey)
			: (new Uint8Array(0) as Uint8Array<ArrayBuffer>);
		const reencrypted = b64urlEncode(
			new Uint8Array(await encryptBytesWithDek(plaintext, newKey)) as Uint8Array<ArrayBuffer>
		);

		const wrappedKeys: Record<string, string> = {};
		for (const m of remaining) {
			wrappedKeys[m.userId] = await wrapKeyForMember(newDek, m.publicKey as string);
		}

		const res = await fetch(`/api/collections/${collection.id}/members`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: removeUserId, blob: reencrypted, wrappedKeys })
		});
		await throwIfNotOk(res);
		return true;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not remove that member.');
		return false;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Promotes a personal collection (a `queue_tag` grouping, see queue-actions.ts)
 * into a shared one. This is the *only* way a shared collection comes into
 * existence — there is deliberately no "create a shared collection from
 * scratch" path, because two independently-created things both called
 * "Collections" is exactly the confusion #145 flagged.
 *
 * The move is one-way and the items genuinely relocate: they are seeded into
 * the collection blob and then tombstoned locally, so the shared copy is the
 * single source of truth and a member's watch state lives in the per-account
 * `watch` map rather than a local `watched_at`. Callers must warn the user
 * before invoking this — once promoted, the titles live only on the server,
 * reachable solely through this account's keys.
 *
 * Ordering is deliberate: the blob is written *before* anything is deleted
 * locally, so a failure at any step leaves the personal collection intact.
 */
export async function promoteCollection(
	name: string,
	items: WatchlistItem[],
	deps: CollectionActionDeps
): Promise<SharedCollection | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const tagged = items.filter((i) => i.queue_tag === name && !i.deleted_at);

		const personalDek = await requirePersonalDek();
		const publicKey = await ensureKeypair(personalDek);

		const dekB64 = await generateShareKey();
		const wrappedKey = await wrapKeyForMember(dekB64, publicKey);

		const res = await fetch('/api/collections', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, wrappedKey })
		});
		await throwIfNotOk(res);
		const collection = (await res.json()) as SharedCollection;

		// The creator is the first member, so their account id is the owner id
		// the server just echoed back — no extra round trip to learn who we are.
		const me = collection.ownerUserId;
		const seeded = tagged.map((item) => toCollectionItem(item, me));

		const dek = await importDek(dekB64, false);
		await syncCollectionItems(collection.id, dek, [], () => seeded, collection.memberDekVersion);

		// Only now that the blob is durably written do the local copies go. Soft
		// deletes, so the removal propagates to this account's other devices
		// through the normal personal-sync tombstone path rather than silently
		// reappearing on the next pull.
		for (const item of tagged) await removeItem(item.id);

		return collection;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not share this collection.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Reshapes a personal queue item for a collection blob. Two fields change
 * meaning in the move: `watched_at` is a single user's fact, so it becomes
 * this account's entry in the per-member `watch` map, and authorship is
 * recorded explicitly since a shared item can no longer be assumed to be the
 * reader's own. The local `id` and `queue_tag` are dropped — a collection
 * item's identity is `tmdb_id`+`media_type`, and its grouping is the
 * collection itself.
 */
function toCollectionItem(item: WatchlistItem, accountId: string): CollectionItem {
	const { id: _id, queue_tag: _tag, watched_at, ...rest } = item;
	return {
		...rest,
		watched_at,
		watch: watched_at ? { [accountId]: watched_at } : {},
		added_by_account_id: accountId
	} as CollectionItem;
}

/**
 * Loads a shared collection's items and ballots for the queue view. Resolves
 * the collection's DEK from its wrapped copy, then pulls and decrypts — a
 * read-only fetch, no push, so opening a collection never risks colliding
 * with a concurrent writer. Ballots come back alongside items (one blob
 * pull covers both) since every surface that shows items also needs ballots
 * to render ranks and the group tally.
 */
export async function loadCollectionItems(
	collection: SharedCollection,
	deps: CollectionActionDeps
): Promise<{ items: CollectionItem[]; ballots: Record<string, BallotEntry> }> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const dekB64 = await openCollectionKey(collection.wrappedKey);
		const dek = await importDek(dekB64, false);
		return await fetchCollectionState(collection.id, dek, collection.memberDekVersion);
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not load this collection.');
		return { items: [], ballots: {} };
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Toggles this account's own watch mark on one item and pushes the change.
 * Only this account's entry in the `watch` map is touched — see
 * mergeCollectionWatch for why a whole-item write would risk clobbering
 * someone else's mark on retry.
 */
export async function toggleCollectionWatched(
	collection: SharedCollection,
	current: CollectionItem[],
	item: CollectionItem,
	myAccountId: string,
	watched: boolean,
	deps: CollectionActionDeps
): Promise<CollectionItem[] | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const dekB64 = await openCollectionKey(collection.wrappedKey);
		const dek = await importDek(dekB64, false);
		return await syncCollectionItems(
			collection.id,
			dek,
			current,
			(merged) =>
				merged.map((i) => {
					if (i.tmdb_id !== item.tmdb_id || i.media_type !== item.media_type) return i;
					const watch = { ...(i.watch ?? {}) };
					if (watched) watch[myAccountId] = new Date().toISOString();
					else delete watch[myAccountId];
					return { ...i, watch };
				}),
			collection.memberDekVersion
		);
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not save that. Try again.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Sets the one shared note on an item (#155/#236) — a single string, not a
 * per-account map like `watch`, so this replaces the whole field rather than
 * merging one account's entry into it. Owner-only is enforced by which
 * callers get offered this function (the UI only renders the edit control
 * for `collection.role === 'owner'') — see the module-level note on
 * removeItemFromSharedCollection for why that's a UI restriction, not a
 * server one: the blob is opaque to the API either way — see the comment on
 * removeItemFromSharedCollection below for the full reasoning.
 */
export async function setCollectionItemNote(
	collection: SharedCollection,
	current: CollectionItem[],
	item: CollectionItem,
	notes: string | null,
	deps: CollectionActionDeps
): Promise<CollectionItem[] | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const dekB64 = await openCollectionKey(collection.wrappedKey);
		const dek = await importDek(dekB64, false);
		return await syncCollectionItems(
			collection.id,
			dek,
			current,
			(merged) =>
				merged.map((i) =>
					i.tmdb_id !== item.tmdb_id || i.media_type !== item.media_type
						? i
						: // updated_at must move forward here — unlike `watch` (merged
							// per-account, LWW-exempt), `notes` falls under mergeCollectionItem's
							// generic whole-field LWW bucket. Without a fresh timestamp this
							// edit could lose to a stale `updated_at` on the next merge.
							{ ...i, notes: notes ?? undefined, updated_at: new Date().toISOString() }
				),
			collection.memberDekVersion
		);
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not save that note.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Replaces this account's own ballot and pushes the change. Whole-ballot
 * replace, not a per-item edit — see mergeCollectionBallots for why a ranked
 * list can't be merged item-by-item the way `watch` marks are; a member's
 * ballot is one ordered thing, not several independent marks. Capped to
 * MAX_BALLOT_SIZE again here even though the UI already enforces it, so a
 * bug upstream can't push an oversized ballot.
 */
export async function setMyBallot(
	collection: SharedCollection,
	currentBallots: Record<string, BallotEntry>,
	myAccountId: string,
	itemsInOrder: string[],
	deps: CollectionActionDeps
): Promise<Record<string, BallotEntry> | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const dekB64 = await openCollectionKey(collection.wrappedKey);
		const dek = await importDek(dekB64, false);
		const entry: BallotEntry = {
			items: itemsInOrder.slice(0, MAX_BALLOT_SIZE),
			updatedAt: new Date().toISOString()
		};
		return await syncCollectionBallots(
			collection.id,
			dek,
			currentBallots,
			(merged) => ({
				...merged,
				[myAccountId]: entry
			}),
			collection.memberDekVersion
		);
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not save your ranking. Try again.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Renames a shared collection. Owner-only — enforced server-side, since the
 * name is a property every member sees, not a personal preference.
 */
export async function renameSharedCollection(
	collection: SharedCollection,
	name: string,
	deps: CollectionActionDeps
): Promise<SharedCollection | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const res = await fetch(`/api/collections/${collection.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		await throwIfNotOk(res);
		const { name: savedName } = (await res.json()) as { id: string; name: string };
		return { ...collection, name: savedName };
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not rename this list.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Sets a shared collection's color. Owner-only, same reasoning as
 * renameSharedCollection — every member sees this color, so it isn't a
 * personal preference any member should be able to change unilaterally.
 */
export async function setSharedCollectionColor(
	collection: SharedCollection,
	color: string,
	deps: CollectionActionDeps
): Promise<SharedCollection | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const res = await fetch(`/api/collections/${collection.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ color })
		});
		await throwIfNotOk(res);
		const { color: savedColor } = (await res.json()) as { id: string; color: string };
		return { ...collection, color: savedColor };
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not change the list color.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Assigns items to an existing shared collection — the general form of what
 * promoting a whole personal list already does for all of its items at once
 * (see promoteCollection above), now for an arbitrary subset, as few as one.
 * Same ordering guarantee: the blob write happens before anything is removed
 * locally, so a failure at any point leaves the personal queue untouched.
 *
 * Mirrors "assign to a personal list" in the UI — a shared list is just
 * another option in the same picker, not a separate flow. The difference is
 * what happens underneath: a personal tag is a local field, so setting it is
 * instant; a shared list lives in a collection blob only members can open,
 * so it costs a member lookup (to attribute authorship) and a pull-merge-push.
 */
export async function addItemsToSharedCollection(
	collection: SharedCollection,
	items: WatchlistItem[],
	deps: CollectionActionDeps
): Promise<boolean> {
	if (items.length === 0) return true;
	deps.setBusy(true);
	deps.setError('');
	try {
		const status = getSyncStatus();
		const members = await listMembers(collection.id, { setBusy: () => {}, setError: () => {} });
		const me = members.find((m) => m.email === status.email)?.userId;
		if (!me) {
			deps.setError('Could not confirm your membership in this list. Try reopening it first.');
			return false;
		}

		const dekB64 = await openCollectionKey(collection.wrappedKey);
		const dek = await importDek(dekB64, false);

		await syncCollectionItems(
			collection.id,
			dek,
			[],
			(merged) => {
				const existingKeys = new Set(merged.map((i) => itemKey(i)));
				const additions = items
					.filter((item) => !existingKeys.has(itemKey(item)))
					.map((item) => toCollectionItem(item, me));
				return [...merged, ...additions];
			},
			collection.memberDekVersion
		);

		for (const item of items) {
			await removeItem(item.id);
		}
		return true;
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not add to this shared list.');
		return false;
	} finally {
		deps.setBusy(false);
	}
}

/**
 * Removes one item from a shared collection.
 *
 * Owner-only in the UI, not on the server: the blob is opaque to the API —
 * `PUT .../blob` only checks membership, since the server can't see inside
 * an encrypted payload to tell a removal from any other write. That's the
 * same reason toggling watched or adding items isn't role-gated either.
 * Restricting *removal* to the owner is therefore enforced only by which
 * button the client renders, same trust boundary as the rest of this file's
 * item-level mutations — real protection would need the server to be able
 * to read the blob, which would defeat the point of encrypting it.
 */
export async function removeItemFromSharedCollection(
	collection: SharedCollection,
	current: CollectionItem[],
	item: CollectionItem,
	deps: CollectionActionDeps
): Promise<CollectionItem[] | null> {
	deps.setBusy(true);
	deps.setError('');
	try {
		const dekB64 = await openCollectionKey(collection.wrappedKey);
		const dek = await importDek(dekB64, false);
		return await syncCollectionItems(
			collection.id,
			dek,
			current,
			(merged) =>
				merged.filter((i) => i.tmdb_id !== item.tmdb_id || i.media_type !== item.media_type),
			collection.memberDekVersion
		);
	} catch (e) {
		deps.setError(e instanceof Error ? e.message : 'Could not remove that. Try again.');
		return null;
	} finally {
		deps.setBusy(false);
	}
}
