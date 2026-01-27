import type { StateStorage } from "./interface.js";

export interface CloudflareKVConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

export class CloudflareKVStorage implements StateStorage {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: CloudflareKVConfig) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}`;
    this.headers = {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  async get(key: string): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/values/${encodeURIComponent(key)}`, {
      method: "GET",
      headers: this.headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`KV get failed: ${error}`);
    }

    return response.text();
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const url = new URL(`${this.baseUrl}/values/${encodeURIComponent(key)}`);
    if (ttl) {
      url.searchParams.set("expiration_ttl", ttl.toString());
    }

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: this.headers.Authorization,
        "Content-Type": "text/plain",
      },
      body: value,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`KV set failed: ${error}`);
    }
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/values/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`KV delete failed: ${error}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  async keys(pattern?: string): Promise<string[]> {
    const url = new URL(`${this.baseUrl}/keys`);
    if (pattern) {
      const prefix = pattern.replace(/\*$/, "");
      url.searchParams.set("prefix", prefix);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`KV keys failed: ${error}`);
    }

    const data = (await response.json()) as {
      result: Array<{ name: string }>;
      success: boolean;
    };

    if (!data.success) {
      throw new Error("KV keys request unsuccessful");
    }

    return data.result.map((item) => item.name);
  }
}
