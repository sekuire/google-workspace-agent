import { google, Auth } from "googleapis";
import type { StateStorage, UserToken } from "./storage/index.js";

export const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/documents",
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

export interface GoogleAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export class GoogleAuthManager {
	private config: GoogleAuthConfig;
	private storage: StateStorage;
	private clientCache = new Map<string, Auth.OAuth2Client>();

	constructor(config: GoogleAuthConfig, storage: StateStorage) {
		this.config = config;
		this.storage = storage;
	}

	getAuthUrl(state?: string): string {
		const oauth2Client = this.createOAuthClient();
		return oauth2Client.generateAuthUrl({
			access_type: "offline",
			scope: GOOGLE_SCOPES,
			prompt: "consent",
			state,
		});
	}

	async handleCallback(code: string): Promise<UserToken> {
		const oauth2Client = this.createOAuthClient();
		const { tokens } = await oauth2Client.getToken(code);

		if (!tokens.refresh_token) {
			throw new Error(
				"No refresh token received. User may need to revoke access and re-authorize.",
			);
		}

		oauth2Client.setCredentials(tokens);
		const userInfo = await this.getUserInfo(oauth2Client);

		const userToken: UserToken = {
			userId: userInfo.id,
			email: userInfo.email,
			accessToken: tokens.access_token || "",
			refreshToken: tokens.refresh_token,
			expiresAt: tokens.expiry_date || undefined,
			scopes: GOOGLE_SCOPES,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await this.storeToken(userToken);
		return userToken;
	}

	async getClientForUser(userId: string): Promise<Auth.OAuth2Client | null> {
		const cached = this.clientCache.get(userId);
		if (cached) return cached;

		const token = await this.getToken(userId);
		if (!token) return null;

		const oauth2Client = this.createOAuthClient();
		oauth2Client.setCredentials({
			access_token: token.accessToken,
			refresh_token: token.refreshToken,
			expiry_date: token.expiresAt,
		});

		oauth2Client.on("tokens", async (newTokens) => {
			if (newTokens.access_token) {
				token.accessToken = newTokens.access_token;
				token.updatedAt = Date.now();
				if (newTokens.expiry_date) {
					token.expiresAt = newTokens.expiry_date;
				}
				await this.storeToken(token);
			}
		});

		this.clientCache.set(userId, oauth2Client);
		return oauth2Client;
	}

	async getClientForEmail(email: string): Promise<Auth.OAuth2Client | null> {
		const userId = await this.getUserIdByEmail(email);
		if (!userId) return null;
		return this.getClientForUser(userId);
	}

	async hasUser(userId: string): Promise<boolean> {
		return this.storage.exists(`token:${userId}`);
	}

	async hasUserByEmail(email: string): Promise<boolean> {
		const userId = await this.getUserIdByEmail(email);
		return userId !== null;
	}

	async removeUser(userId: string): Promise<void> {
		const token = await this.getToken(userId);
		if (token) {
			await this.storage.delete(`email:${token.email}`);
		}
		await this.storage.delete(`token:${userId}`);
		this.clientCache.delete(userId);
	}

	async listUsers(): Promise<UserToken[]> {
		const keys = await this.storage.keys("token:*");
		const tokens: UserToken[] = [];

		for (const key of keys) {
			const data = await this.storage.get(key);
			if (data) {
				tokens.push(JSON.parse(data));
			}
		}

		return tokens;
	}

	private createOAuthClient(): Auth.OAuth2Client {
		return new google.auth.OAuth2(
			this.config.clientId,
			this.config.clientSecret,
			this.config.redirectUri,
		);
	}

	private async getUserInfo(
		oauth2Client: Auth.OAuth2Client,
	): Promise<{ id: string; email: string }> {
		const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
		const { data } = await oauth2.userinfo.get();
		return {
			id: data.id || "",
			email: data.email || "",
		};
	}

	private async storeToken(token: UserToken): Promise<void> {
		await this.storage.set(`token:${token.userId}`, JSON.stringify(token));
		await this.storage.set(`email:${token.email}`, token.userId);
	}

	private async getToken(userId: string): Promise<UserToken | null> {
		const data = await this.storage.get(`token:${userId}`);
		if (!data) return null;
		return JSON.parse(data);
	}

	private async getUserIdByEmail(email: string): Promise<string | null> {
		return this.storage.get(`email:${email}`);
	}
}
