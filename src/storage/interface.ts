export interface StateStorage {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttl?: number): Promise<void>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
	keys(pattern?: string): Promise<string[]>;
}

export interface UserToken {
	userId: string;
	email: string;
	accessToken: string;
	refreshToken: string;
	expiresAt?: number;
	scopes: string[];
	createdAt: number;
	updatedAt: number;
}
