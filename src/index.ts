import "dotenv/config";
import express from "express";
import { getAgent, SekuireCrypto, SekuireSDK } from "@sekuire/sdk";
import { GoogleWorkspaceServer } from "./server.js";
import { GoogleClientFactory } from "./google-factory.js";
import {
	InMemoryStateStorage,
	CloudflareKVStorage,
	CloudflareD1Memory,
	type StateStorage,
	type MemoryStorage,
} from "./storage/index.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Config {
	port: number;
	agentId: string;
	workspaceId: string;
	apiUrl: string;
	google: {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
	};
}

async function loadSekuireId(): Promise<string> {
	const projectRoot = path.resolve(__dirname, "..");
	const configPath = path.join(projectRoot, "sekuire.yml");

	try {
		const configContent = await fs.readFile(configPath, "utf-8");
		const systemPromptPath = path.join(projectRoot, "prompts", "system.md");
		const toolsPath = path.join(projectRoot, "tools.json");

		const systemPrompt = await fs
			.readFile(systemPromptPath, "utf-8")
			.catch(() => "");
		const tools = await fs.readFile(toolsPath, "utf-8").catch(() => "{}");

		const modelMatch = configContent.match(/model:\s*["']?([^"'\n]+)["']?/);
		const nameMatch = configContent.match(/name:\s*["']?([^"'\n]+)["']?/);
		const versionMatch = configContent.match(/version:\s*["']?([^"'\n]+)["']?/);

		const model = modelMatch?.[1] || "gemini-1.5-flash";
		const name = nameMatch?.[1] || "google-workspace-agent";
		const version = versionMatch?.[1] || "1.0.0";

		return SekuireCrypto.calculateSekuireId({
			model,
			systemPrompt,
			tools,
			projectName: name,
			projectVersion: version,
		});
	} catch (error) {
		console.warn(
			"[Config] Could not calculate Sekuire ID from config, using fallback",
		);
		return `sekuire_google_workspace_${Date.now()}`;
	}
}

async function loadConfig(): Promise<Config> {
	const port = parseInt(process.env.PORT || "8002", 10);
	const workspaceId = process.env.SEKUIRE_WORKSPACE_ID || "local-workspace";
	const apiUrl = process.env.SEKUIRE_API_URL || "http://localhost:5556";

	const googleClientId = process.env.GOOGLE_CLIENT_ID;
	const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

	if (!googleClientId || !googleClientSecret) {
		console.error("[Config] Missing Google OAuth credentials");
		console.error("   Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET");
		console.error("   Users will connect their accounts via /auth/google");
		process.exit(1);
	}

	let agentId = process.env.SEKUIRE_AGENT_ID || "";
	if (!agentId) {
		agentId = await loadSekuireId();
		console.log(`[Config] Calculated Sekuire ID: ${agentId}`);
	}

	const redirectUri =
		process.env.GOOGLE_REDIRECT_URI ||
		`http://localhost:${port}/auth/google/callback`;

	return {
		port,
		agentId,
		workspaceId,
		apiUrl,
		google: {
			clientId: googleClientId,
			clientSecret: googleClientSecret,
			redirectUri,
		},
	};
}

function initializeStorage(): {
	state: StateStorage;
	memory: MemoryStorage | null;
} {
	const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const cfApiToken = process.env.CLOUDFLARE_API_TOKEN;
	const cfKvNamespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
	const cfD1DatabaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;

	let state: StateStorage;
	let memory: MemoryStorage | null = null;

	if (cfAccountId && cfApiToken && cfKvNamespaceId) {
		state = new CloudflareKVStorage({
			accountId: cfAccountId,
			apiToken: cfApiToken,
			namespaceId: cfKvNamespaceId,
		});
		console.log("[Storage] Cloudflare KV initialized for state/tokens");
	} else {
		state = new InMemoryStateStorage();
		console.log("[Storage] In-memory storage initialized for state/tokens");
		console.log(
			"[Storage] Set CLOUDFLARE_KV_NAMESPACE_ID for persistent storage",
		);
	}

	if (cfAccountId && cfApiToken && cfD1DatabaseId) {
		memory = new CloudflareD1Memory({
			accountId: cfAccountId,
			apiToken: cfApiToken,
			databaseId: cfD1DatabaseId,
		});
		console.log("[Storage] Cloudflare D1 initialized for memory/context");
	} else {
		console.log("[Storage] No D1 configured - memory will use SDK default");
		console.log(
			"[Storage] Set CLOUDFLARE_D1_DATABASE_ID for persistent memory",
		);
	}

	return { state, memory };
}

async function initializeAgent(memory: MemoryStorage | null) {
	try {
		if (!process.env.GOOGLE_API_KEY) {
			console.warn(
				"[Agent] No GOOGLE_API_KEY set - agent will run in tool-only mode",
			);
			return undefined;
		}

		const projectRoot = path.resolve(__dirname, "..");
		const configPath = path.join(projectRoot, "sekuire.yml");

		const overrides = memory ? { memory } : undefined;
		const agent = await getAgent(undefined, overrides, configPath);
		console.log(`[Agent] Initialized with Gemini (${agent.getLLMProvider()})`);
		return agent;
	} catch (error) {
		console.warn(`[Agent] Could not initialize Gemini agent: ${error}`);
		return undefined;
	}
}

async function main() {
	console.log("\n============================================");
	console.log("  Google Workspace Agent");
	console.log("  Sekuire - The Trust Protocol for AI Agents");
	console.log("============================================\n");

	const config = await loadConfig();

	const sdk = new SekuireSDK({
		agentId: config.agentId,
		agentName: "Google Workspace Agent",
		apiUrl: config.apiUrl,
		workspaceId: config.workspaceId,
		privateKey: process.env.SEKUIRE_PRIVATE_KEY,
		installToken: process.env.SEKUIRE_INSTALL_TOKEN,
		autoHeartbeat: true,
		loggingEnabled: true,
	});

	const { state: storage, memory } = initializeStorage();

	const clientFactory = new GoogleClientFactory(
		{
			clientId: config.google.clientId,
			clientSecret: config.google.clientSecret,
			redirectUri: config.google.redirectUri,
		},
		storage,
	);
	console.log("[Google] Client factory initialized");
	console.log(`[Google] OAuth redirect URI: ${config.google.redirectUri}`);

	const agent = await initializeAgent(memory);

	const app = express();
	app.use(express.json());

	const server = new GoogleWorkspaceServer(app, {
		...config,
		clientFactory,
		storage,
		agent,
		sdk,
		adminKey: process.env.SEKUIRE_ADMIN_KEY,
		skipAuth: process.env.SKIP_A2A_AUTH === "true",
	});

	await sdk.start();
	console.log("[Sekuire] SDK started - heartbeat and logging active");

	const installCreds = sdk.getInstallationCredentials();
	if (installCreds) {
		console.log("[Sekuire] Installation credentials available for recovery:");
		console.log(`   SEKUIRE_INSTALLATION_ID=${installCreds.installationId}`);
		console.log(`   SEKUIRE_REFRESH_TOKEN=${installCreds.refreshToken}`);
	}

	let worker: ReturnType<typeof sdk.createTaskWorker> | null = null;

	try {
		worker = sdk.createTaskWorker();
		worker.onCommand((cmd) => {
			sdk.log(
				"tool_execution",
				{ command: cmd.type, reason: cmd.reason },
				"info",
			);
			if (cmd.type === "terminate") {
				cleanup();
			}
		});
		await worker.start();
		console.log("[Sekuire] TaskWorker started - listening for commands");
	} catch (err) {
		console.warn(
			"[Sekuire] TaskWorker not available - running in standalone mode",
		);
		console.warn(
			`[Sekuire] Reason: ${err instanceof Error ? err.message : err}`,
		);
	}

	async function cleanup() {
		console.log("[Shutdown] Cleaning up...");
		if (worker) await worker.stop();
		await sdk.shutdown();
		process.exit(0);
	}

	process.on("SIGTERM", () => {
		console.log("\n[Shutdown] Received SIGTERM");
		cleanup();
	});

	process.on("SIGINT", () => {
		console.log("\n[Shutdown] Received SIGINT");
		cleanup();
	});

	sdk.log("health", { message: "Agent started", port: config.port }, "info");

	server.start();
}

main().catch((error) => {
	console.error("Failed to start Google Workspace agent:", error);
	process.exit(1);
});
