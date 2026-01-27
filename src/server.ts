import type { Request, Response, Application } from "express";
import type { Agent, SekuireSDK } from "@sekuire/sdk";
import { GoogleWorkspaceHandler, type A2ATaskRequest } from "./a2a/handler.js";
import { GoogleDocsTools } from "./tools/google-docs.js";
import { GoogleClientFactory } from "./google-factory.js";
import type { StateStorage } from "./storage/index.js";

export interface ServerConfig {
  port: number;
  agentId: string;
  workspaceId: string;
  apiUrl: string;
  clientFactory: GoogleClientFactory;
  storage: StateStorage;
  agent?: Agent;
  sdk?: SekuireSDK;
}

export class GoogleWorkspaceServer {
  private app: Application;
  private config: ServerConfig;
  private startTime: number;
  private requestCount = 0;

  constructor(app: Application, config: ServerConfig) {
    this.app = app;
    this.config = config;
    this.startTime = Date.now();

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
    this.app.get("/health", this.handleHealth.bind(this));
    this.app.get("/metrics", this.handleMetrics.bind(this));
    this.app.get("/agent/info", this.handleAgentInfo.bind(this));
    this.app.get("/.well-known/agent.json", this.handleAgentCard.bind(this));
    this.app.post("/a2a/tasks", this.handleA2ATask.bind(this));
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
      description: "Sekuire AI Agent for Google Workspace - Create, edit, and manage Google Docs",
      capabilities: [
        "google:docs:create",
        "google:docs:read",
        "google:docs:update",
        "google:docs:append",
        "google:docs:list",
        "google:drive:search",
        "task:chat",
      ],
      tools: ["create_document", "read_document", "update_document", "append_to_document", "list_documents", "search_drive"],
      status: "running",
      workspace_id: this.config.workspaceId,
      api_url: this.config.apiUrl,
      connected_users: users.map((u) => ({ userId: u.userId, email: u.email })),
      endpoints: {
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

  private async handleA2ATask(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    try {
      const taskRequest = req.body as A2ATaskRequest;

      if (!taskRequest || (!taskRequest.task_id && !taskRequest.type && !taskRequest.description)) {
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
            message: userEmail || userId
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

      this.config.sdk?.log("tool_execution", {
        tool: taskRequest.type || "task:chat",
        task_id: taskRequest.task_id,
        user_email: userEmail,
        status: result.status,
        duration_ms: Date.now() - startTime,
      }, result.status === "completed" ? "info" : "error");

      res.json(result);
    } catch (error) {
      this.config.sdk?.log("tool_execution", {
        tool: "a2a_task",
        error: error instanceof Error ? error.message : "Unknown error",
        duration_ms: Date.now() - startTime,
      }, "error");

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
        message: err instanceof Error ? err.message : "Failed to exchange authorization code",
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

  private handleHandshake(req: Request, res: Response): void {
    const { client_nonce } = req.body as { client_nonce?: string };

    if (!client_nonce) {
      res.status(400).json({ error: "Missing client_nonce" });
      return;
    }

    const agentNonce = `nonce_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.json({
      agent_id: this.config.agentId,
      agent_nonce: agentNonce,
      client_nonce: client_nonce,
      signature: `sig_placeholder_${client_nonce.slice(0, 8)}`,
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
      description: "Sekuire AI Agent for Google Workspace - Create, edit, and manage Google Docs",
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
      console.log(`   Health:      http://localhost:${port}/health`);
      console.log(`   Metrics:     http://localhost:${port}/metrics`);
      console.log(`   Tasks:       http://localhost:${port}/a2a/tasks`);
      console.log(`   Agent Card:  http://localhost:${port}/.well-known/agent.json`);
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
      console.log(`\n[Google Workspace Agent] Ready and listening on port ${port}`);
    });
  }
}
