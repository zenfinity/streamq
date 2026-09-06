declare global {
	namespace App {
		interface Platform {
			env?: {
				SHARE_KV?: KVNamespace;
				DB?: D1Database;
			};
		}
		interface Locals {
			/** Resolved from the session cookie in hooks.server.ts; null when signed out or the session is missing/expired. */
			user: { id: string; email: string } | null;
		}
	}
}

export {};
