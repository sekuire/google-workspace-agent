import "dotenv/config";
import express from "express";
import pino from "pino";
import { getAgent, SekuireCrypto, SekuireSDK } from "@sekuire/sdk";
import { GoogleWorkspaceServer } from "./server.js";
import { GoogleDocsTools } from "./tools/google-docs.js";
import { GoogleWorkspaceHandler } from "./a2a/handler.js";
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

const log = pino({ name: "google-workspace-agent" });

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
		log.warn("Could not calculate Sekuire ID from config, using fallback");
		return `sekuire_google_workspace_${Date.now()}`;
	}
}

async function loadConfig(): Promise<Config> {
	const port = parseInt(process.env.PORT || "8002", 10);
	const workspaceId = process.env.SEKUIRE_WORKSPACE_ID || "local-workspace";
	const apiUrl = process.env.SEKUIRE_API_URL || "";

	const googleClientId = process.env.GOOGLE_CLIENT_ID;
	const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

	if (!googleClientId || !googleClientSecret) {
		log.fatal(
			"Missing Google OAuth credentials: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
		);
		process.exit(1);
	}

	let agentId = process.env.SEKUIRE_AGENT_ID || "";
	if (!agentId) {
		agentId = await loadSekuireId();
		log.info({ agentId }, "Calculated Sekuire ID");
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
		log.info("Cloudflare KV initialized for state/tokens");
	} else {
		state = new InMemoryStateStorage();
		log.info(
			"In-memory storage initialized (set CLOUDFLARE_KV_NAMESPACE_ID for persistent storage)",
		);
	}

	if (cfAccountId && cfApiToken && cfD1DatabaseId) {
		memory = new CloudflareD1Memory({
			accountId: cfAccountId,
			apiToken: cfApiToken,
			databaseId: cfD1DatabaseId,
		});
		log.info("Cloudflare D1 initialized for memory/context");
	} else {
		log.info(
			"No D1 configured (set CLOUDFLARE_D1_DATABASE_ID for persistent memory)",
		);
	}

	return { state, memory };
}

async function initializeAgent(memory: MemoryStorage | null) {
	try {
		if (!process.env.GOOGLE_API_KEY) {
			log.warn("No GOOGLE_API_KEY set - agent will run in tool-only mode");
			return undefined;
		}

		const projectRoot = path.resolve(__dirname, "..");
		const configPath = path.join(projectRoot, "sekuire.yml");

		const overrides = memory ? { memory } : undefined;
		const agent = await getAgent(undefined, overrides, configPath);
		log.info(
			{ provider: agent.getLLMProvider() },
			"Agent initialized with Gemini",
		);
		return agent;
	} catch (error) {
		log.warn({ error }, "Could not initialize Gemini agent");
		return undefined;
	}
}

async function main() {
	log.info("Google Workspace Agent - Sekuire");

	const config = await loadConfig();

	const hasValidApiUrl = Boolean(
		config.apiUrl && !config.apiUrl.includes("localhost"),
	);

	const sdk = new SekuireSDK({
		agentId: config.agentId,
		agentName: "Google Workspace Agent",
		apiUrl: config.apiUrl || "http://localhost:5556",
		workspaceId: config.workspaceId,
		privateKey: process.env.SEKUIRE_PRIVATE_KEY,
		installToken: process.env.SEKUIRE_INSTALL_TOKEN,
		autoHeartbeat: hasValidApiUrl,
		loggingEnabled: true,
	});

	if (!hasValidApiUrl) {
		log.info("No remote API URL configured - heartbeat disabled");
	}

	const { state: storage, memory } = initializeStorage();

	const clientFactory = new GoogleClientFactory(
		{
			clientId: config.google.clientId,
			clientSecret: config.google.clientSecret,
			redirectUri: config.google.redirectUri,
		},
		storage,
	);
	log.info(
		{ redirectUri: config.google.redirectUri },
		"Google client factory initialized",
	);

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
	sdk.log("health", { message: "SDK started - heartbeat and logging active" });

	const installCreds = sdk.getInstallationCredentials();
	if (installCreds) {
		sdk.log("health", {
			message: "Installation credentials available for recovery",
			installation_id: installCreds.installationId,
			refresh_token: installCreds.refreshToken,
		});
	}

	let worker: ReturnType<typeof sdk.createTaskWorker> | null = null;

	try {
		worker = sdk.createTaskWorker();

		const capabilities = [
			"google:docs:create",
			"google:docs:read",
			"google:docs:update",
			"google:docs:append",
			"google:docs:list",
			"google:drive:search",
			"task:chat",
		];

		for (const cap of capabilities) {
			worker.onTask(cap, async (ctx, input) => {
				const userEmail = input.user_email as string | undefined;
				const userId = input.user_id as string | undefined;

				let client = null;
				if (userId) client = await clientFactory.getClientForUser(userId);
				else if (userEmail)
					client = await clientFactory.getClientForEmail(userEmail);

				if (!client) {
					throw new Error(
						"User not authorized - connect Google account via /auth/google",
					);
				}

				const tools = new GoogleDocsTools(client);
				const handler = new GoogleWorkspaceHandler(tools, agent);
				return handler.handleSSETask(ctx, input);
			});
		}

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
		sdk.log("health", {
			message: "TaskWorker started - listening for commands",
		});
	} catch (err) {
		sdk.log(
			"health",
			{
				message: "TaskWorker not available - running in standalone mode",
				reason: err instanceof Error ? err.message : String(err),
			},
			"warn",
		);
	}

	async function cleanup(signal?: string) {
		sdk.log("health", { message: "Shutting down", signal });
		if (worker) await worker.stop();
		await sdk.shutdown();
		process.exit(0);
	}

	process.on("SIGTERM", () => cleanup("SIGTERM"));
	process.on("SIGINT", () => cleanup("SIGINT"));

	sdk.log("health", { message: "Agent started", port: config.port }, "info");

	server.start();
}

main().catch((error) => {
	log.fatal({ error }, "Failed to start Google Workspace agent");
	process.exit(1);
});
