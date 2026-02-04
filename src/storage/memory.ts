import type { StateStorage } from "./interface.js";

interface StoredValue {
	value: string;
	expiresAt?: number;
}

export class InMemoryStateStorage implements StateStorage {
	private store = new Map<string, StoredValue>();

	async get(key: string): Promise<string | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		if (entry.expiresAt && Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return null;
		}

		return entry.value;
	}

	async set(key: string, value: string, ttl?: number): Promise<void> {
		const entry: StoredValue = { value };
		if (ttl) {
			entry.expiresAt = Date.now() + ttl * 1000;
		}
		this.store.set(key, entry);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		const value = await this.get(key);
		return value !== null;
	}

	async keys(pattern?: string): Promise<string[]> {
		const allKeys = Array.from(this.store.keys());
		if (!pattern) return allKeys;

		const regex = new RegExp(pattern.replace(/\*/g, ".*"));
		return allKeys.filter((key) => regex.test(key));
	}
}
