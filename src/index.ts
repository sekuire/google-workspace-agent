import "dotenv/config";
import express from "express";
import { getAgent, SekuireCrypto, SekuireSDK, TaskWorker } from "@sekuire/sdk";
import { GoogleWorkspaceServer } from "./server.js";
import { GoogleWorkspaceClient } from "./google-client.js";
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
    refreshToken: string;
  };
}

async function loadSekuireId(): Promise<string> {
  const projectRoot = path.resolve(__dirname, "..");
  const configPath = path.join(projectRoot, "sekuire.yml");

  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const systemPromptPath = path.join(projectRoot, "prompts", "system.md");
    const toolsPath = path.join(projectRoot, "tools.json");

    const systemPrompt = await fs.readFile(systemPromptPath, "utf-8").catch(() => "");
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
    console.warn("[Config] Could not calculate Sekuire ID from config, using fallback");
    return `sekuire_google_workspace_${Date.now()}`;
  }
}

async function loadConfig(): Promise<Config> {
  const port = parseInt(process.env.PORT || "8002", 10);
  const workspaceId = process.env.SEKUIRE_WORKSPACE_ID || "local-workspace";
  const apiUrl = process.env.SEKUIRE_API_URL || "http://localhost:5556";

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
    console.error("[Config] Missing Google OAuth credentials");
    console.error("   Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN");
    process.exit(1);
  }

  let agentId = process.env.SEKUIRE_AGENT_ID || "";
  if (!agentId) {
    agentId = await loadSekuireId();
    console.log(`[Config] Calculated Sekuire ID: ${agentId}`);
  }

  return {
    port,
    agentId,
    workspaceId,
    apiUrl,
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken: googleRefreshToken,
    },
  };
}

async function initializeAgent() {
  try {
    if (!process.env.GOOGLE_API_KEY) {
      console.warn("[Agent] No GOOGLE_API_KEY set - agent will run in tool-only mode");
      return undefined;
    }

    const projectRoot = path.resolve(__dirname, "..");
    const configPath = path.join(projectRoot, "sekuire.yml");

    const agent = await getAgent(undefined, undefined, configPath);
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
    apiKey: process.env.SEKUIRE_API_KEY,
    workspaceId: config.workspaceId,
    privateKey: process.env.SEKUIRE_PRIVATE_KEY,
    autoHeartbeat: true,
    loggingEnabled: true,
  });

  const worker = new TaskWorker({
    apiBaseUrl: config.apiUrl,
    token: process.env.SEKUIRE_AUTH_TOKEN || "",
    agentId: config.agentId,
    apiKey: process.env.SEKUIRE_API_KEY,
  });

  const googleClient = new GoogleWorkspaceClient(config.google);
  console.log("[Google] Client initialized");

  const agent = await initializeAgent();

  const app = express();
  app.use(express.json());

  const server = new GoogleWorkspaceServer(app, {
    ...config,
    googleClient,
    agent,
    sdk,
  });

  worker.onCommand((cmd) => {
    sdk.log("tool_execution", { command: cmd.type, reason: cmd.reason }, "info");
    if (cmd.type === "terminate") {
      cleanup();
    }
  });

  async function cleanup() {
    console.log("[Shutdown] Cleaning up...");
    await worker.stop();
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

  await sdk.start();
  console.log("[Sekuire] SDK started - heartbeat and logging active");

  await worker.start();
  console.log("[Sekuire] TaskWorker started - listening for commands");

  sdk.log("health", { message: "Agent started", port: config.port }, "info");

  server.start();
}

main().catch((error) => {
  console.error("Failed to start Google Workspace agent:", error);
  process.exit(1);
});
