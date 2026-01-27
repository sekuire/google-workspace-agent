import { GoogleWorkspaceClient } from "./google-client.js";
import { GoogleAuthManager, GoogleAuthConfig } from "./google-auth.js";
import type { StateStorage, UserToken } from "./storage/index.js";

export class GoogleClientFactory {
  private authManager: GoogleAuthManager;
  private clientCache = new Map<string, GoogleWorkspaceClient>();

  constructor(config: GoogleAuthConfig, storage: StateStorage) {
    this.authManager = new GoogleAuthManager(config, storage);
  }

  getAuthUrl(state?: string): string {
    return this.authManager.getAuthUrl(state);
  }

  async handleOAuthCallback(code: string): Promise<UserToken> {
    const token = await this.authManager.handleCallback(code);
    this.clientCache.delete(token.userId);
    return token;
  }

  async getClientForUser(userId: string): Promise<GoogleWorkspaceClient | null> {
    const cached = this.clientCache.get(userId);
    if (cached) return cached;

    const auth = await this.authManager.getClientForUser(userId);
    if (!auth) return null;

    const client = new GoogleWorkspaceClient(auth);
    this.clientCache.set(userId, client);
    return client;
  }

  async getClientForEmail(email: string): Promise<GoogleWorkspaceClient | null> {
    const auth = await this.authManager.getClientForEmail(email);
    if (!auth) return null;

    const client = new GoogleWorkspaceClient(auth);
    return client;
  }

  async hasUser(userId: string): Promise<boolean> {
    return this.authManager.hasUser(userId);
  }

  async hasUserByEmail(email: string): Promise<boolean> {
    return this.authManager.hasUserByEmail(email);
  }

  async removeUser(userId: string): Promise<void> {
    await this.authManager.removeUser(userId);
    this.clientCache.delete(userId);
  }

  async listUsers(): Promise<UserToken[]> {
    return this.authManager.listUsers();
  }
}
