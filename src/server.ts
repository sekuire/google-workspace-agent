import type { Request, Response, Application } from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import type { Agent, SekuireSDK } from "@sekuire/sdk";
import { GoogleWorkspaceHandler, type A2ATaskRequest } from "./a2a/handler.js";
import { GoogleDocsTools } from "./tools/google-docs.js";
import { GoogleClientFactory } from "./google-factory.js";
import type { StateStorage } from "./storage/index.js";
import { createA2AAuthMiddleware } from "./middleware/auth.js";

export interface ServerConfig {
	port: number;
	agentId: string;
	workspaceId: string;
	apiUrl: string;
	clientFactory: GoogleClientFactory;
	storage: StateStorage;
	agent?: Agent;
	sdk?: SekuireSDK;
	adminKey?: string;
	skipAuth?: boolean;
}

export class GoogleWorkspaceServer {
	private app: Application;
	private config: ServerConfig;
	private startTime: number;
	private requestCount = 0;
	private projectRoot: string;

	constructor(app: Application, config: ServerConfig) {
		this.app = app;
		this.config = config;
		this.startTime = Date.now();
		this.projectRoot = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
		);

		this.setupMiddleware();
		this.setupRoutes();
	}

	private setupMiddleware(): void {
		this.app.use((req: Request, _res: Response, next) => {
			this.requestCount++;
			console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
			next();
		});
	}

	private setupRoutes(): void {
		this.app.get("/", this.handleIndex.bind(this));
		this.app.get("/health", this.handleHealth.bind(this));
		this.app.get("/metrics", this.handleMetrics.bind(this));
		this.app.get("/agent/info", this.handleAgentInfo.bind(this));
		this.app.get("/.well-known/agent.json", this.handleAgentCard.bind(this));

		const a2aRateLimiter = rateLimit({
			windowMs: 60 * 1000,
			max: 60,
			message: {
				error: {
					code: "rate_limit_exceeded",
					message: "Rate limit exceeded: 60 requests per minute",
				},
			},
			standardHeaders: true,
			legacyHeaders: false,
		});

		const a2aAuth = createA2AAuthMiddleware({
			sdk: this.config.sdk,
			adminKey: this.config.adminKey,
			skipAuth: this.config.skipAuth,
		});
		this.app.post(
			"/a2a/tasks",
			a2aRateLimiter,
			a2aAuth,
			this.handleA2ATask.bind(this),
		);

		this.app.post("/sekuire/handshake", this.handleHandshake.bind(this));
		this.app.get("/sekuire/hello", this.handleHello.bind(this));

		this.app.get("/auth/google", this.handleAuthStart.bind(this));
		this.app.get("/auth/google/callback", this.handleAuthCallback.bind(this));
		this.app.get("/auth/users", this.handleListUsers.bind(this));
		this.app.delete("/auth/users/:userId", this.handleRemoveUser.bind(this));
	}

	private handleHealth(_req: Request, res: Response): void {
		res.json({
			status: "healthy",
			timestamp: new Date().toISOString(),
			uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
			agent_id: this.config.agentId,
			workspace_id: this.config.workspaceId,
		});
	}

	private async handleMetrics(_req: Request, res: Response): Promise<void> {
		const memUsage = process.memoryUsage();
		const users = await this.config.clientFactory.listUsers();

		res.json({
			uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
			requests_total: this.requestCount,
			connected_users: users.length,
			memory_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
			cpu_percent: 0,
		});
	}

	private async handleAgentInfo(_req: Request, res: Response): Promise<void> {
		const users = await this.config.clientFactory.listUsers();

		res.json({
			sekuire_id: this.config.agentId,
			name: "Google Workspace Agent",
			version: "1.0.0",
			description:
				"Sekuire AI Agent for Google Workspace - Create, edit, and manage Google Docs",
			capabilities: [
				"google:docs:create",
				"google:docs:read",
				"google:docs:update",
				"google:docs:append",
				"google:docs:list",
				"google:drive:search",
				"task:chat",
			],
			tools: [
				"create_document",
				"read_document",
				"update_document",
				"append_to_document",
				"list_documents",
				"search_drive",
			],
			status: "running",
			workspace_id: this.config.workspaceId,
			api_url: this.config.apiUrl,
			connected_users: users.map((u) => ({ userId: u.userId, email: u.email })),
			endpoints: {
				root: "/",
				health: "/health",
				metrics: "/metrics",
				a2a_tasks: "/a2a/tasks",
				agent_card: "/.well-known/agent.json",
				agent_info: "/agent/info",
				handshake: "/sekuire/handshake",
				auth_start: "/auth/google",
				auth_callback: "/auth/google/callback",
				auth_users: "/auth/users",
			},
		});
	}

	private async handleIndex(req: Request, res: Response): Promise<void> {
		const readme = await this.readReadme();
		if (readme) {
			const accept = req.headers.accept || "";
			if (accept.includes("text/html")) {
				res.type("html").send(this.renderReadmeHtml(readme));
				return;
			}
			res.type("text/markdown").send(readme);
			return;
		}

		res.json({
			name: "Google Workspace Agent",
			description:
				"Sekuire AI Agent for Google Workspace - Create, edit, and manage Google Docs",
			docs: {
				agent_info: "/agent/info",
				agent_card: "/.well-known/agent.json",
			},
			endpoints: {
				health: "/health",
				metrics: "/metrics",
				a2a_tasks: "/a2a/tasks",
				handshake: "/sekuire/handshake",
				auth_start: "/auth/google",
				auth_callback: "/auth/google/callback",
				auth_users: "/auth/users",
			},
		});
	}

	private async handleA2ATask(req: Request, res: Response): Promise<void> {
		const startTime = Date.now();
		try {
			const taskRequest = req.body as A2ATaskRequest;

			if (
				!taskRequest ||
				(!taskRequest.task_id && !taskRequest.type && !taskRequest.description)
			) {
				res.status(400).json({
					task_id: "unknown",
					status: "failed",
					error: {
						code: "invalid_request",
						message: "Request must include task_id, type, or description",
					},
					execution_time_ms: 0,
				});
				return;
			}

			const userEmail = taskRequest.context?.user_email as string | undefined;
			const userId = taskRequest.context?.user_id as string | undefined;

			let client = null;
			if (userId) {
				client = await this.config.clientFactory.getClientForUser(userId);
			} else if (userEmail) {
				client = await this.config.clientFactory.getClientForEmail(userEmail);
			}

			if (!client) {
				res.status(401).json({
					task_id: taskRequest.task_id || "unknown",
					status: "failed",
					error: {
						code: "user_not_authorized",
						message:
							userEmail || userId
								? `User not authorized. Please connect Google account first via /auth/google`
								: "Missing user_email or user_id in task context",
					},
					execution_time_ms: Date.now() - startTime,
				});
				return;
			}

			const tools = new GoogleDocsTools(client);
			const handler = new GoogleWorkspaceHandler(tools, this.config.agent);
			const result = await handler.handleTask(taskRequest);

			this.config.sdk?.log(
				"tool_execution",
				{
					tool: taskRequest.type || "task:chat",
					task_id: taskRequest.task_id,
					user_email: userEmail,
					status: result.status,
					duration_ms: Date.now() - startTime,
				},
				result.status === "completed" ? "info" : "error",
			);

			res.json(result);
		} catch (error) {
			this.config.sdk?.log(
				"tool_execution",
				{
					tool: "a2a_task",
					error: error instanceof Error ? error.message : "Unknown error",
					duration_ms: Date.now() - startTime,
				},
				"error",
			);

			res.status(500).json({
				task_id: "unknown",
				status: "failed",
				error: {
					code: "internal_error",
					message: error instanceof Error ? error.message : "Unknown error",
				},
				execution_time_ms: 0,
			});
		}
	}

	private handleAuthStart(req: Request, res: Response): void {
		const state = req.query.state as string | undefined;
		const authUrl = this.config.clientFactory.getAuthUrl(state);
		res.redirect(authUrl);
	}

	private async handleAuthCallback(req: Request, res: Response): Promise<void> {
		const code = req.query.code as string | undefined;
		const error = req.query.error as string | undefined;

		if (error) {
			res.status(400).json({
				error: "oauth_error",
				message: error,
			});
			return;
		}

		if (!code) {
			res.status(400).json({
				error: "missing_code",
				message: "No authorization code received",
			});
			return;
		}

		try {
			const token = await this.config.clientFactory.handleOAuthCallback(code);
			res.json({
				success: true,
				message: "Google account connected successfully",
				user: {
					userId: token.userId,
					email: token.email,
				},
			});
		} catch (err) {
			res.status(500).json({
				error: "token_exchange_failed",
				message:
					err instanceof Error
						? err.message
						: "Failed to exchange authorization code",
			});
		}
	}

	private async handleListUsers(_req: Request, res: Response): Promise<void> {
		const users = await this.config.clientFactory.listUsers();
		res.json({
			users: users.map((u) => ({
				userId: u.userId,
				email: u.email,
				createdAt: new Date(u.createdAt).toISOString(),
				updatedAt: new Date(u.updatedAt).toISOString(),
			})),
		});
	}

	private async handleRemoveUser(req: Request, res: Response): Promise<void> {
		const userId = req.params.userId as string;
		await this.config.clientFactory.removeUser(userId);
		res.json({ success: true, message: `User ${userId} removed` });
	}

	private async handleHandshake(req: Request, res: Response): Promise<void> {
		const { client_nonce } = req.body as { client_nonce?: string };

		if (!client_nonce) {
			res.status(400).json({ error: "Missing client_nonce" });
			return;
		}

		const agentNonce = crypto.randomBytes(32).toString("hex");

		let signature = "";
		if (this.config.sdk) {
			try {
				signature = await this.config.sdk.sign(client_nonce);
			} catch (error) {
				console.warn("[Handshake] Failed to sign client_nonce:", error);
			}
		}

		res.json({
			agent_id: this.config.agentId,
			agent_nonce: agentNonce,
			signature_c: signature,
			credentials: [],
			timestamp: new Date().toISOString(),
			capabilities: [
				"google:docs:create",
				"google:docs:read",
				"google:docs:update",
				"google:docs:append",
				"google:docs:list",
				"google:drive:search",
				"task:chat",
			],
		});
	}

	private handleHello(_req: Request, res: Response): void {
		res.json({
			agent_id: this.config.agentId,
			protocol_version: "1.0",
			capabilities: [
				"google:docs:create",
				"google:docs:read",
				"google:docs:update",
				"google:docs:append",
				"google:docs:list",
				"google:drive:search",
				"task:chat",
			],
			status: "ready",
		});
	}

	private handleAgentCard(_req: Request, res: Response): void {
		const capabilities = [
			"google:docs:create",
			"google:docs:read",
			"google:docs:update",
			"google:docs:append",
			"google:docs:list",
			"google:drive:search",
			"task:chat",
		];

		const skills = capabilities.map((cap) => ({
			id: cap,
			name: cap.replace(/:/g, " ").replace(/_/g, " "),
			description: `Capability: ${cap}`,
			tags: [cap.split(":")[0]],
			inputModes: ["text/plain", "application/json"],
			outputModes: ["text/plain", "application/json"],
		}));

		res.json({
			agentId: `sekuire:${this.config.agentId}`,
			name: "Google Workspace Agent",
			description:
				"Sekuire AI Agent for Google Workspace - Create, edit, and manage Google Docs",
			version: "1.0.0",
			provider: {
				name: "Sekuire",
				url: "https://sekuire.com",
			},
			protocolVersions: ["1.0"],
			capabilities: {
				streaming: false,
				pushNotifications: false,
				extendedAgentCard: false,
			},
			skills,
			defaultInputModes: ["text/plain", "application/json"],
			defaultOutputModes: ["text/plain", "application/json"],
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
				},
			},
			security: ["bearerAuth"],
			url: `http://localhost:${this.config.port}/a2a`,
		});
	}

	start(): void {
		const { port, agentId, workspaceId, apiUrl } = this.config;

		this.app.listen(port, () => {
			console.log(`\n[Google Workspace Agent] Starting...`);
			console.log(`   Agent ID: ${agentId}`);
			console.log(`   Workspace: ${workspaceId}`);
			console.log(`   API URL: ${apiUrl}`);
			console.log(`\n[Endpoints]`);
			console.log(`   Root:        http://localhost:${port}/`);
			console.log(`   Health:      http://localhost:${port}/health`);
			console.log(`   Metrics:     http://localhost:${port}/metrics`);
			console.log(`   Tasks:       http://localhost:${port}/a2a/tasks`);
			console.log(
				`   Agent Card:  http://localhost:${port}/.well-known/agent.json`,
			);
			console.log(`   Info:        http://localhost:${port}/agent/info`);
			console.log(`   Auth:        http://localhost:${port}/auth/google`);
			console.log(`   Users:       http://localhost:${port}/auth/users`);
			console.log(`\n[Capabilities]`);
			console.log(`   - google:docs:create`);
			console.log(`   - google:docs:read`);
			console.log(`   - google:docs:update`);
			console.log(`   - google:docs:append`);
			console.log(`   - google:docs:list`);
			console.log(`   - google:drive:search`);
			console.log(`   - task:chat`);
			console.log(
				`\n[Google Workspace Agent] Ready and listening on port ${port}`,
			);
		});
	}

	private async readReadme(): Promise<string | null> {
		try {
			const readmePath = path.join(this.projectRoot, "README.md");
			return await fs.readFile(readmePath, "utf-8");
		} catch {
			return null;
		}
	}

	private renderReadmeHtml(readme: string): string {
		const escaped = readme
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");

		return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Workspace Agent Docs</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; margin: 32px; color: #111827; background: #f8fafc; }
      .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
      pre { white-space: pre-wrap; margin: 0; font-size: 14px; line-height: 1.55; }
      h1 { font-size: 22px; margin: 0 0 16px; }
      .hint { margin-bottom: 12px; font-size: 13px; color: #6b7280; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Google Workspace Agent</h1>
      <div class="hint">This is the repository README rendered as plain text. For JSON docs use /agent/info or /.well-known/agent.json.</div>
      <pre>${escaped}</pre>
    </div>
  </body>
</html>`;
	}
}
