import { GoogleWorkspaceClient, DocumentInfo, DocumentContent, DriveFile } from "../google-client.js";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export class GoogleDocsTools {
  private client: GoogleWorkspaceClient;

  constructor(client: GoogleWorkspaceClient) {
    this.client = client;
  }

  async createDocument(params: {
    title: string;
    content?: string;
    folder_id?: string;
  }): Promise<ToolResult> {
    try {
      const doc = await this.client.createDocument(
        params.title,
        params.content,
        params.folder_id
      );

      return {
        success: true,
        data: {
          message: `Document "${params.title}" created successfully`,
          document: doc,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create document: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async readDocument(params: { document_id: string }): Promise<ToolResult> {
    try {
      const doc = await this.client.readDocument(params.document_id);

      return {
        success: true,
        data: {
          document: doc,
          preview: doc.content.length > 500
            ? doc.content.substring(0, 500) + "..."
            : doc.content,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read document: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async updateDocument(params: {
    document_id: string;
    content: string;
  }): Promise<ToolResult> {
    try {
      const doc = await this.client.updateDocument(params.document_id, params.content);

      return {
        success: true,
        data: {
          message: `Document "${doc.title}" updated successfully`,
          document: doc,
          content_length: params.content.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to update document: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async appendToDocument(params: {
    document_id: string;
    content: string;
  }): Promise<ToolResult> {
    try {
      const doc = await this.client.appendToDocument(params.document_id, params.content);

      return {
        success: true,
        data: {
          message: `Content appended to "${doc.title}" successfully`,
          document: doc,
          appended_length: params.content.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to append to document: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async listDocuments(params: {
    folder_id?: string;
    query?: string;
    limit?: number;
  }): Promise<ToolResult> {
    try {
      const documents = await this.client.listDocuments(
        params.folder_id,
        params.query,
        params.limit || 20
      );

      return {
        success: true,
        data: {
          count: documents.length,
          documents,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list documents: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async searchDrive(params: {
    query: string;
    file_type?: "document" | "spreadsheet" | "presentation" | "any";
    limit?: number;
  }): Promise<ToolResult> {
    try {
      const files = await this.client.searchDrive(
        params.query,
        params.file_type || "any",
        params.limit || 20
      );

      return {
        success: true,
        data: {
          count: files.length,
          files,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to search Drive: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case "create_document":
        return this.createDocument(params as { title: string; content?: string; folder_id?: string });
      case "read_document":
        return this.readDocument(params as { document_id: string });
      case "update_document":
        return this.updateDocument(params as { document_id: string; content: string });
      case "append_to_document":
        return this.appendToDocument(params as { document_id: string; content: string });
      case "list_documents":
        return this.listDocuments(params as { folder_id?: string; query?: string; limit?: number });
      case "search_drive":
        return this.searchDrive(params as { query: string; file_type?: "document" | "spreadsheet" | "presentation" | "any"; limit?: number });
      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
        };
    }
  }
}
