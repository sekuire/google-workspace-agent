import type { Request, Response, Application } from "express";
import type { Agent, SekuireSDK } from "@sekuire/sdk";
import { GoogleWorkspaceHandler, type A2ATaskRequest } from "./a2a/handler.js";
import { GoogleDocsTools } from "./tools/google-docs.js";
import { GoogleWorkspaceClient } from "./google-client.js";

export interface ServerConfig {
  port: number;
  agentId: string;
  workspaceId: string;
  apiUrl: string;
  googleClient: GoogleWorkspaceClient;
  agent?: Agent;
  sdk?: SekuireSDK;
}

export class GoogleWorkspaceServer {
  private app: Application;
  private config: ServerConfig;
  private handler: GoogleWorkspaceHandler;
  private startTime: number;
  private requestCount = 0;

  constructor(app: Application, config: ServerConfig) {
    this.app = app;
    this.config = config;
    this.startTime = Date.now();

    const tools = new GoogleDocsTools(config.googleClient);
    this.handler = new GoogleWorkspaceHandler(tools, config.agent);

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

  private handleMetrics(_req: Request, res: Response): void {
    const memUsage = process.memoryUsage();

    res.json({
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      requests_total: this.requestCount,
      tasks_processed: this.handler.getTaskCount(),
      memory_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
      cpu_percent: 0,
    });
  }

  private handleAgentInfo(_req: Request, res: Response): void {
    res.json({
      sekuire_id: this.config.agentId,
      name: "Google Workspace Agent",
      version: "1.0.0",
      description: "Sekuire AI Agent for Google Workspace - Create, edit, and manage Google Docs",
      capabilities: this.handler.getCapabilities(),
      tools: ["create_document", "read_document", "update_document", "append_to_document", "list_documents", "search_drive"],
      status: "running",
      workspace_id: this.config.workspaceId,
      api_url: this.config.apiUrl,
      endpoints: {
        health: "/health",
        metrics: "/metrics",
        a2a_tasks: "/a2a/tasks",
        agent_card: "/.well-known/agent.json",
        agent_info: "/agent/info",
        handshake: "/sekuire/handshake",
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

      const result = await this.handler.handleTask(taskRequest);

      this.config.sdk?.log("tool_execution", {
        tool: taskRequest.type || "task:chat",
        task_id: taskRequest.task_id,
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

  private handleHandshake(req: Request, res: Response): void {
    const { client_nonce, client_id } = req.body as { client_nonce?: string; client_id?: string };

    if (!client_nonce) {
      res.status(400).json({
        error: "Missing client_nonce",
      });
      return;
    }

    const agentNonce = `nonce_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.json({
      agent_id: this.config.agentId,
      agent_nonce: agentNonce,
      client_nonce: client_nonce,
      signature: `sig_placeholder_${client_nonce.slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      capabilities: this.handler.getCapabilities(),
    });
  }

  private handleHello(_req: Request, res: Response): void {
    res.json({
      agent_id: this.config.agentId,
      protocol_version: "1.0",
      capabilities: this.handler.getCapabilities(),
      status: "ready",
    });
  }

  private handleAgentCard(_req: Request, res: Response): void {
    const capabilities = this.handler.getCapabilities();
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
      console.log(`   Handshake:   http://localhost:${port}/sekuire/handshake`);
      console.log(`\n[Capabilities]`);
      for (const cap of this.handler.getCapabilities()) {
        console.log(`   - ${cap}`);
      }
      console.log(`\n[Google Workspace Agent] Ready and listening on port ${port}`);
    });
  }
}
