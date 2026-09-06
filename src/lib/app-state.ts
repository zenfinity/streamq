// Canonical shape of "the whole app's state" — the one module owning
// serialize/deserialize, consumed by export, restore, and (later) the sync
// engine. Previously this shape was hand-rolled in up to four places; #92
// collapsed that to two (settings-actions.ts's buildExportBlob and
// share-schema.ts's parseImportBackup), and this module collapses it to one.
//
// ── The synced/local key partition is the sync contract ─────────────────
//
// There are 16 real sq:-prefixed localStorage keys. Some of them describe
// *this device* rather than the user's account, and must never sync:
//
//   sq:welcomed                 — onboarding seen on this device
//   sq:import-missed            — leftover diagnostics from the last CSV import
//   sq:dismiss-cancel           — per-provider alert dismissals (device-local)
//   sq:budget-callout-dismissed — first-visit callout state
//   sq:nav-hint-dismissed       — swipe/keyboard tab-nav hint seen on this device
//   sq:shared-list-colors       — per-device color swatches for shared lists;
//                                 unlike sq:queue:colors (personal lists),
//                                 not wired into buildPrefs/applyPrefs, so it
//                                 doesn't travel with an export or sync pull
//
// (#242 removed the other four per-hint dismissal keys — list/share/sync/
// ranking — along with the floating-pill system they belonged to; those
// hints are now permanent in-flow copy with no dismissal state at all.
// sq:hints-disabled, the global "stop showing tips" kill switch, went with
// them rather than being repurposed: the one hint shape left with a
// dismissal key (nav) is a single 5px dot, not disruptive enough to
// warrant its own synced preference. Existing synced clients carrying
// either key from before #242 just have it silently ignored on the next
// pull — nothing reads sq:hints-disabled or the four removed dismissal
// keys anywhere in the app any more.)
//
// Every other sq: key belongs in SYNCED_KEYS. Every key must appear in
// exactly one of the two sets below — app-state.test.ts greps the whole
// source tree for sq: string literals and fails if one exists in neither
// (or both).
import type { WatchlistItem, Provider, SeasonSummary, CastMember, ReleaseInfo } from './types';
import { getAll, getAllIncludingDeleted, getServices, NOTE_MAX_LENGTH } from './db';
import { getQueueName, getQueueColors, setQueueName } from './queue-colors';
import { readBoolean } from './storage';
import {
	coerceString,
	coerceNumber,
	coerceBoolean,
	validatePath,
	validateIsoDate
} from './validate';

export const SYNCED_KEYS = [
	'sq:theme',
	'sq:sort',
	'sq:sortDir',
	'sq:view',
	'sq:budget',
	'sq:budget:weekly',
	'sq:budget:weeks',
	'sq:cancel-alerts',
	'sq:queue:name',
	'sq:queue:colors'
] as const;

export const LOCAL_KEYS = [
	'sq:welcomed',
	'sq:import-missed',
	'sq:dismiss-cancel',
	'sq:budget-callout-dismissed',
	'sq:nav-hint-dismissed',
	'sq:shared-list-colors'
] as const;

export const APP_STATE_VERSION = 2;

export interface AppStatePrefs {
	theme?: 'light' | 'dark';
	weeklyHours?: number;
	weeksPerMonth?: number;
	/** Derived (weeklyHours * weeksPerMonth). Kept for older readers that only knew the total. */
	budget?: number;
	queueName?: string;
	queueColors?: Record<string, string>;
	sort?: 'added' | 'runtime' | 'title';
	sortDir?: 'asc' | 'desc';
	view?: 'grid' | 'list' | 'lanes';
	cancelAlerts?: boolean;
}

export interface AppStateSnapshot {
	version: typeof APP_STATE_VERSION;
	prefs: AppStatePrefs;
	items: WatchlistItem[];
	services: Provider[];
}

function readRaw(key: string): string | undefined {
	if (typeof localStorage === 'undefined') return undefined;
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function buildPrefs(): AppStatePrefs {
	const weeklyHours = coerceNumber(JSON.parse(readRaw('sq:budget:weekly') ?? 'null')) ?? 10;
	const weeksPerMonth = coerceNumber(JSON.parse(readRaw('sq:budget:weeks') ?? 'null')) ?? 4;

	return {
		theme: readRaw('sq:theme') === 'light' ? 'light' : 'dark',
		weeklyHours,
		weeksPerMonth,
		budget: weeklyHours * weeksPerMonth,
		queueName: getQueueName(),
		queueColors: getQueueColors(),
		sort: (readRaw('sq:sort') as AppStatePrefs['sort']) ?? 'added',
		sortDir: (readRaw('sq:sortDir') as AppStatePrefs['sortDir']) ?? 'desc',
		view: (readRaw('sq:view') as AppStatePrefs['view']) ?? 'grid',
		cancelAlerts: readBoolean('sq:cancel-alerts', false)
	};
}

/** Builds the full app-state snapshot from IndexedDB + the synced localStorage keys. */
export async function serializeAppState(): Promise<AppStateSnapshot> {
	const [items, services] = await Promise.all([getAll(), getServices()]);
	return { version: APP_STATE_VERSION, prefs: buildPrefs(), items, services };
}

/**
 * Same as serializeAppState, but for the sync engine (#101) rather than
 * export/backup: includes soft-deleted rows (getAllIncludingDeleted) so
 * tombstones actually propagate to other devices instead of silently
 * vanishing from every payload that would otherwise carry them.
 */
export async function serializeSyncSnapshot(): Promise<AppStateSnapshot> {
	const [items, services] = await Promise.all([getAllIncludingDeleted(), getServices()]);
	return { version: APP_STATE_VERSION, prefs: buildPrefs(), items, services };
}

/**
 * Writes a prefs object back to the synced localStorage keys — the sync
 * engine's counterpart to restoreBackup's inline prefs-apply block in
 * import-actions.ts. Not shared with that code path directly: restore also
 * drives a couple of UI callbacks (theme toggle state, etc.) that don't
 * apply to a background sync pull.
 */
export function applyPrefs(prefs: AppStatePrefs): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (prefs.theme) {
			localStorage.setItem('sq:theme', prefs.theme);
			document.documentElement?.classList.toggle('dark', prefs.theme === 'dark');
		}
		if (typeof prefs.weeklyHours === 'number') {
			localStorage.setItem('sq:budget:weekly', JSON.stringify(prefs.weeklyHours));
		}
		if (typeof prefs.weeksPerMonth === 'number') {
			localStorage.setItem('sq:budget:weeks', JSON.stringify(prefs.weeksPerMonth));
		}
		if (typeof prefs.budget === 'number') {
			localStorage.setItem('sq:budget', JSON.stringify(prefs.budget));
		}
		if (typeof prefs.queueName === 'string') setQueueName(prefs.queueName);
		if (prefs.queueColors)
			localStorage.setItem('sq:queue:colors', JSON.stringify(prefs.queueColors));
		if (prefs.sort) localStorage.setItem('sq:sort', prefs.sort);
		if (prefs.sortDir) localStorage.setItem('sq:sortDir', prefs.sortDir);
		if (prefs.view) localStorage.setItem('sq:view', prefs.view);
		if (typeof prefs.cancelAlerts === 'boolean') {
			localStorage.setItem('sq:cancel-alerts', String(prefs.cancelAlerts));
		}
	} catch {
		// Best-effort localStorage write; a failed pref write here isn't fatal —
		// the item/service sync (the actual point of the engine) already applied.
	}
}

// ── Deserialize (untrusted input: backup files, and later sync snapshots
// from other devices) — parseShareItem-grade validation: every field is
// rebuilt from an allowlist, strings/arrays are length-clamped, and paths
// are regex-validated rather than trusted and cast.

export type BackupItem = Omit<WatchlistItem, 'id'>;

function parseSeason(raw: unknown): SeasonSummary | null {
	if (!raw || typeof raw !== 'object') return null;
	const s = raw as Record<string, unknown>;
	const season_number = coerceNumber(s.season_number);
	if (season_number === null) return null;
	return {
		season_number,
		episode_count: coerceNumber(s.episode_count, 1000) ?? 0,
		name: coerceString(s.name, 200),
		runtime_minutes: coerceNumber(s.runtime_minutes, 100000) ?? 0
	};
}

function parseCastMember(raw: unknown): CastMember | null {
	if (!raw || typeof raw !== 'object') return null;
	const c = raw as Record<string, unknown>;
	const name = coerceString(c.name, 200);
	if (!name) return null;
	const id = coerceNumber(c.id);
	return {
		name,
		character: coerceString(c.character, 200),
		profile_path: validatePath(c.profile_path),
		...(id !== null ? { id } : {})
	};
}

function parseRelease(raw: unknown): ReleaseInfo | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	return {
		theatrical_date: validateIsoDate(r.theatrical_date),
		digital_date: validateIsoDate(r.digital_date),
		streaming_estimate:
			typeof r.streaming_estimate === 'string' ? r.streaming_estimate.slice(0, 100) : null,
		next_season: coerceNumber(r.next_season, 1000),
		next_season_date: validateIsoDate(r.next_season_date),
		currently_airing: coerceBoolean(r.currently_airing),
		status: typeof r.status === 'string' ? r.status.slice(0, 100) : null
	};
}

function parseProvider(raw: unknown): Provider | null {
	if (!raw || typeof raw !== 'object') return null;
	const p = raw as Record<string, unknown>;
	const provider_id = coerceNumber(p.provider_id);
	const provider_name = coerceString(p.provider_name, 100);
	const logo_path = validatePath(p.logo_path);
	if (provider_id === null || provider_id === 0 || !provider_name || !logo_path) return null;
	return { provider_id, provider_name, logo_path };
}

/**
 * Exported as the untrusted-item validator for collection blobs (#188) —
 * a collection blob is written by other members' devices, which makes it at
 * least as untrusted as a backup file someone hands you, so it goes through
 * exactly the same allowlist rather than a separate, easier-to-drift copy.
 */
export function parseBackupItemPublic(raw: unknown): BackupItem | null {
	return parseBackupItem(raw);
}

function parseBackupItem(raw: unknown): BackupItem | null {
	if (!raw || typeof raw !== 'object') return null;
	const item = raw as Record<string, unknown>;

	const media_type = item.media_type;
	if (media_type !== 'movie' && media_type !== 'tv') return null;

	const tmdb_id = coerceNumber(item.tmdb_id);
	if (tmdb_id === null || tmdb_id === 0) return null;

	const title = coerceString(item.title, 500);
	if (!title) return null;

	const providers = Array.isArray(item.providers)
		? item.providers
				.slice(0, 50)
				.map(parseProvider)
				.filter((p): p is Provider => p !== null)
		: [];

	const seasons = Array.isArray(item.seasons)
		? item.seasons
				.slice(0, 100)
				.map(parseSeason)
				.filter((s): s is SeasonSummary => s !== null)
		: [];

	const watched_seasons = Array.isArray(item.watched_seasons)
		? item.watched_seasons.filter((n): n is number => typeof n === 'number').slice(0, 100)
		: [];

	const cast = Array.isArray(item.cast)
		? item.cast
				.slice(0, 100)
				.map(parseCastMember)
				.filter((c): c is CastMember => c !== null)
		: undefined;

	const genres = Array.isArray(item.genres)
		? item.genres.filter((g): g is string => typeof g === 'string').slice(0, 20)
		: undefined;

	const queue_tag = typeof item.queue_tag === 'string' ? item.queue_tag.slice(0, 40) : undefined;

	return {
		tmdb_id,
		media_type,
		title,
		poster_path: validatePath(item.poster_path),
		overview: typeof item.overview === 'string' ? item.overview.slice(0, 5000) : null,
		year: typeof item.year === 'string' && /^\d{4}$/.test(item.year) ? item.year : null,
		providers,
		rentable: coerceBoolean(item.rentable),
		runtime_minutes: coerceNumber(item.runtime_minutes, 100000),
		seasons,
		watched_seasons,
		added_at: validateIsoDate(item.added_at) ?? new Date().toISOString(),
		watched_at: validateIsoDate(item.watched_at),
		updated_at: validateIsoDate(item.updated_at) ?? undefined,
		deleted_at: validateIsoDate(item.deleted_at),
		release: parseRelease(item.release),
		...(queue_tag ? { queue_tag } : {}),
		...(genres ? { genres } : {}),
		...(cast ? { cast } : {}),
		director: typeof item.director === 'string' ? item.director.slice(0, 200) : null,
		director_id: coerceNumber(item.director_id),
		creator: typeof item.creator === 'string' ? item.creator.slice(0, 200) : null,
		imdb_id: validateImdbId(item.imdb_id),
		backdrop_path: validatePath(item.backdrop_path),
		...(typeof item.notes === 'string' && item.notes
			? { notes: item.notes.slice(0, NOTE_MAX_LENGTH) }
			: {}),
		...(parseWatch(item.watch) ? { watch: parseWatch(item.watch) } : {}),
		...(typeof item.added_by_account_id === 'string' && ACCOUNT_ID_RE.test(item.added_by_account_id)
			? { added_by_account_id: item.added_by_account_id }
			: item.added_by_account_id === null
				? { added_by_account_id: null }
				: {})
	};
}

/**
 * Validates a per-account watch map: account id -> ISO date they marked this
 * watched. Built on Object.create(null) rather than `{}` — the keys are
 * attacker-controlled (this parses untrusted sync payloads), and a
 * null-prototype object means an incoming "__proto__" key becomes an inert
 * own property instead of reassigning the object's prototype. "constructor"
 * and "prototype" are rejected outright as a second layer, since a
 * null-prototype object still has neither of those as meaningful own keys
 * but there is no reason to accept them.
 *
 * Capped at 50 entries — a shared collection with more concurrent watchers
 * than that is not a case this app is built for, and an unbounded map is an
 * unbounded payload from an untrusted source.
 */
const MAX_WATCH_ENTRIES = 50;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseWatch(raw: unknown): Record<string, string> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const out: Record<string, string> = Object.create(null);
	let count = 0;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (count >= MAX_WATCH_ENTRIES) break;
		if (DANGEROUS_KEYS.has(key) || !ACCOUNT_ID_RE.test(key)) continue;
		const iso = validateIsoDate(value);
		if (!iso) continue;
		out[key] = iso;
		count++;
	}
	return count > 0 ? out : undefined;
}

/** TMDB's imdb_id format is always "tt" + digits (e.g. "tt0111161"). */
function validateImdbId(val: unknown): string | null {
	if (typeof val !== 'string' || !/^tt\d+$/.test(val)) return null;
	return val;
}

function parsePrefs(raw: unknown): AppStatePrefs | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const p = raw as Record<string, unknown>;

	const prefs: AppStatePrefs = {
		...(typeof p.theme === 'string' && ['light', 'dark'].includes(p.theme)
			? { theme: p.theme as AppStatePrefs['theme'] }
			: {}),
		...(typeof p.weeklyHours === 'number' && p.weeklyHours > 0
			? { weeklyHours: Math.round(p.weeklyHours) }
			: {}),
		...(typeof p.weeksPerMonth === 'number' && p.weeksPerMonth > 0
			? { weeksPerMonth: Math.round(p.weeksPerMonth) }
			: {}),
		...(typeof p.budget === 'number' && p.budget > 0 ? { budget: Math.round(p.budget) } : {}),
		...(typeof p.queueName === 'string' ? { queueName: p.queueName.slice(0, 100) } : {}),
		...(p.queueColors && typeof p.queueColors === 'object'
			? {
					queueColors: Object.fromEntries(
						Object.entries(p.queueColors as Record<string, unknown>)
							.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
							.slice(0, 50)
							.map(([k, v]) => [k.slice(0, 100), v.slice(0, 50)])
					)
				}
			: {}),
		...(typeof p.sort === 'string' && ['added', 'runtime', 'title'].includes(p.sort)
			? { sort: p.sort as AppStatePrefs['sort'] }
			: {}),
		...(typeof p.sortDir === 'string' && ['asc', 'desc'].includes(p.sortDir)
			? { sortDir: p.sortDir as AppStatePrefs['sortDir'] }
			: {}),
		...(typeof p.view === 'string' && ['grid', 'list', 'lanes'].includes(p.view)
			? { view: p.view as AppStatePrefs['view'] }
			: {}),
		...(typeof p.cancelAlerts === 'boolean' ? { cancelAlerts: p.cancelAlerts } : {})
	};

	return Object.keys(prefs).length > 0 ? prefs : undefined;
}

/**
 * Parses an untrusted app-state payload — a backup file today, a sync
 * snapshot from another device later. Accepts the current version, the
 * legacy v1 shape (no sortDir/cancelAlerts — callers fall back to defaults),
 * and the pre-versioning bare-array format. Anything else is rejected
 * outright rather than silently half-parsed.
 */
export function deserializeAppState(raw: unknown): {
	items: BackupItem[];
	prefs?: AppStatePrefs;
	services?: Provider[];
	/** Items present in the payload that parseBackupItem rejected outright.
	 *  A sync caller (see sync.ts) reports this as a failure signal (#254) —
	 *  a well-formed-looking item from another of the user's own devices
	 *  failing validation is exactly the kind of silent failure that's
	 *  otherwise unknowable. A backup-file-import caller has no reason to
	 *  report it: a hand-edited or years-old export rejecting some items
	 *  isn't a distributed-system health signal, just an expected part of
	 *  reading untrusted input. */
	rejectedItemCount: number;
} {
	if (!raw || typeof raw !== 'object') throw new Error('Invalid backup file');

	// Pre-versioning format: a bare array of items, nothing else.
	if (Array.isArray(raw)) {
		const candidates = raw.slice(0, 5000);
		const items = candidates.map(parseBackupItem).filter((i): i is BackupItem => i !== null);
		return { items, rejectedItemCount: candidates.length - items.length };
	}

	const payload = raw as Record<string, unknown>;
	const version = payload.version;
	if (version !== undefined && version !== 1 && version !== APP_STATE_VERSION) {
		throw new Error('Unsupported backup format version');
	}

	const itemCandidates = Array.isArray(payload.items) ? payload.items.slice(0, 5000) : [];
	const items = itemCandidates.map(parseBackupItem).filter((i): i is BackupItem => i !== null);

	const prefs = parsePrefs(payload.prefs);

	const services = Array.isArray(payload.services)
		? payload.services
				.slice(0, 100)
				.map(parseProvider)
				.filter((s): s is Provider => s !== null)
		: undefined;

	return {
		items,
		rejectedItemCount: itemCandidates.length - items.length,
		...(prefs ? { prefs } : {}),
		...(services && services.length > 0 ? { services } : {})
	};
}
