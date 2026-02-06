import type { Agent, A2ATaskState, SekuireSDK } from "@sekuire/sdk";
import { GoogleDocsTools, ToolResult } from "../tools/google-docs.js";

export interface A2ATaskRequest {
	task_id: string;
	type?: string;
	description?: string;
	input?: Record<string, unknown>;
	context?: Record<string, unknown>;
	timeout_ms?: number;
	from_agent?: string;
	delegation_chain?: string[];
}

export interface A2ATaskResponse {
	task_id: string;
	status: A2ATaskState;
	output?: unknown;
	error?: {
		code: string;
		message: string;
	};
	execution_time_ms: number;
}

export interface TaskCapability {
	type: string;
	description: string;
	handler: (input: Record<string, unknown>, agent?: Agent) => Promise<unknown>;
}

export class GoogleWorkspaceHandler {
	private capabilities: Map<string, TaskCapability> = new Map();
	private tools: GoogleDocsTools;
	private agent?: Agent;
	private sdk?: SekuireSDK;
	private taskCount = 0;

	constructor(tools: GoogleDocsTools, agent?: Agent, sdk?: SekuireSDK) {
		this.tools = tools;
		this.agent = agent;
		this.sdk = sdk;
		this.registerCapabilities();
	}

	private registerCapabilities(): void {
		this.capabilities.set("google:docs:create", {
			type: "google:docs:create",
			description: "Create a new Google Doc",
			handler: async (input) => {
				return this.tools.createDocument({
					title: input.title as string,
					content: input.content as string | undefined,
					folder_id: input.folder_id as string | undefined,
				});
			},
		});

		this.capabilities.set("google:docs:read", {
			type: "google:docs:read",
			description: "Read content from a Google Doc",
			handler: async (input) => {
				return this.tools.readDocument({
					document_id: input.document_id as string,
				});
			},
		});

		this.capabilities.set("google:docs:update", {
			type: "google:docs:update",
			description: "Update content in a Google Doc",
			handler: async (input) => {
				return this.tools.updateDocument({
					document_id: input.document_id as string,
					content: input.content as string,
				});
			},
		});

		this.capabilities.set("google:docs:append", {
			type: "google:docs:append",
			description: "Append content to a Google Doc",
			handler: async (input) => {
				return this.tools.appendToDocument({
					document_id: input.document_id as string,
					content: input.content as string,
				});
			},
		});

		this.capabilities.set("google:docs:list", {
			type: "google:docs:list",
			description: "List Google Docs",
			handler: async (input) => {
				return this.tools.listDocuments({
					folder_id: input.folder_id as string | undefined,
					query: input.query as string | undefined,
					limit: input.limit as number | undefined,
				});
			},
		});

		this.capabilities.set("google:drive:search", {
			type: "google:drive:search",
			description: "Search Google Drive",
			handler: async (input) => {
				return this.tools.searchDrive({
					query: input.query as string,
					file_type: input.file_type as
						| "document"
						| "spreadsheet"
						| "presentation"
						| "any"
						| undefined,
					limit: input.limit as number | undefined,
				});
			},
		});

		this.capabilities.set("task:chat", {
			type: "task:chat",
			description: "Natural language interaction with Google Workspace",
			handler: async (input) => {
				if (!this.agent) {
					return this.handleNaturalLanguageWithoutLLM(input);
				}

				const message =
					(input.message as string) || (input.description as string) || "";
				const response = await this.agent.chat(message);
				return { response };
			},
		});
	}

	private async handleNaturalLanguageWithoutLLM(
		input: Record<string, unknown>,
	): Promise<ToolResult> {
		const message = (
			(input.message as string) ||
			(input.description as string) ||
			""
		).toLowerCase();

		if (message.includes("create") && message.includes("doc")) {
			const titleMatch = message.match(/(?:called|named|titled)\s+"([^"]+)"/i);
			const title = titleMatch?.[1] || "Untitled Document";
			return this.tools.createDocument({ title });
		}

		if (message.includes("list") && message.includes("doc")) {
			return this.tools.listDocuments({});
		}

		if (message.includes("search")) {
			const queryMatch = message.match(
				/(?:search|find)\s+(?:for\s+)?["']?([^"']+)["']?/i,
			);
			const query = queryMatch?.[1] || message;
			return this.tools.searchDrive({ query });
		}

		return {
			success: false,
			error:
				"Could not understand the request. Please use specific tool commands or enable LLM for natural language processing.",
		};
	}

	getCapabilities(): string[] {
		return Array.from(this.capabilities.keys());
	}

	getTaskCount(): number {
		return this.taskCount;
	}

	async handleSSETask(
		ctx: {
			taskId: string;
			workspaceId: string;
			requesterId?: string;
			parentTaskId?: string;
			traceId?: string;
		},
		input: Record<string, unknown>,
	): Promise<unknown> {
		const taskType =
			(input.type as string) || (input.capability as string) || "task:chat";
		const result = await this.handleTask({
			task_id: ctx.taskId,
			type: taskType,
			input,
			context: {
				requester_agent_id: ctx.requesterId,
				trace_id: ctx.traceId,
			},
		});
		if (result.status === "failed") {
			throw new Error(result.error?.message || "Task failed");
		}
		return result.output;
	}

	async handleTask(request: A2ATaskRequest): Promise<A2ATaskResponse> {
		const startTime = Date.now();
		this.taskCount++;

		const taskId = request.task_id || `task_${Date.now()}`;
		const taskType = request.type || "task:chat";
		const input = request.input || { message: request.description };
		const timeoutMs = request.timeout_ms || 30000;

		this.sdk?.log("tool_execution", { task_id: taskId, type: taskType });

		try {
			const capability = this.capabilities.get(taskType);

			if (!capability) {
				if (taskType.startsWith("google:") || taskType.startsWith("task:")) {
					const chatCapability = this.capabilities.get("task:chat");
					if (chatCapability) {
						const result = await this.executeWithTimeout(
							chatCapability.handler(
								{ ...input, description: request.description },
								this.agent,
							),
							timeoutMs,
						);

						return {
							task_id: taskId,
							status: "completed",
							output: result,
							execution_time_ms: Date.now() - startTime,
						};
					}
				}

				return {
					task_id: taskId,
					status: "failed",
					error: {
						code: "unknown_task_type",
						message: `Unknown task type: ${taskType}. Available: ${this.getCapabilities().join(", ")}`,
					},
					execution_time_ms: Date.now() - startTime,
				};
			}

			const result = await this.executeWithTimeout(
				capability.handler(input, this.agent),
				timeoutMs,
			);

			this.sdk?.log("tool_execution", {
				task_id: taskId,
				status: "completed",
				duration_ms: Date.now() - startTime,
			});

			return {
				task_id: taskId,
				status: "completed",
				output: result,
				execution_time_ms: Date.now() - startTime,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const isTimeout = errorMessage.includes("timeout");

			this.sdk?.log(
				"tool_execution",
				{ task_id: taskId, status: "failed", error: errorMessage },
				"error",
			);

			return {
				task_id: taskId,
				status: "failed",
				error: {
					code: isTimeout ? "timeout" : "execution_error",
					message: errorMessage,
				},
				execution_time_ms: Date.now() - startTime,
			};
		}
	}

	private async executeWithTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
	): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`Task timeout after ${timeoutMs}ms`)),
					timeoutMs,
				),
			),
		]);
	}
}
