import { google, docs_v1, drive_v3, Auth } from "googleapis";

export interface DocumentInfo {
	id: string;
	title: string;
	url: string;
	createdTime?: string;
	modifiedTime?: string;
}

export interface DocumentContent {
	id: string;
	title: string;
	content: string;
	url: string;
}

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	url: string;
	createdTime?: string;
	modifiedTime?: string;
}

export class GoogleWorkspaceClient {
	private docs: docs_v1.Docs;
	private drive: drive_v3.Drive;

	constructor(auth: Auth.OAuth2Client) {
		this.docs = google.docs({ version: "v1", auth });
		this.drive = google.drive({ version: "v3", auth });
	}

	async createDocument(
		title: string,
		content?: string,
		folderId?: string,
	): Promise<DocumentInfo> {
		const doc = await this.docs.documents.create({
			requestBody: {
				title,
			},
		});

		const documentId = doc.data.documentId!;

		if (content) {
			await this.docs.documents.batchUpdate({
				documentId,
				requestBody: {
					requests: [
						{
							insertText: {
								location: { index: 1 },
								text: content,
							},
						},
					],
				},
			});
		}

		if (folderId) {
			await this.drive.files.update({
				fileId: documentId,
				addParents: folderId,
				fields: "id, parents",
			});
		}

		return {
			id: documentId,
			title,
			url: `https://docs.google.com/document/d/${documentId}/edit`,
		};
	}

	async readDocument(documentId: string): Promise<DocumentContent> {
		const doc = await this.docs.documents.get({
			documentId,
		});

		const content = this.extractTextContent(doc.data);

		return {
			id: documentId,
			title: doc.data.title || "Untitled",
			content,
			url: `https://docs.google.com/document/d/${documentId}/edit`,
		};
	}

	async updateDocument(
		documentId: string,
		content: string,
	): Promise<DocumentInfo> {
		const doc = await this.docs.documents.get({ documentId });
		const endIndex = this.getDocumentEndIndex(doc.data);

		const requests: docs_v1.Schema$Request[] = [];

		if (endIndex > 1) {
			requests.push({
				deleteContentRange: {
					range: {
						startIndex: 1,
						endIndex: endIndex,
					},
				},
			});
		}

		requests.push({
			insertText: {
				location: { index: 1 },
				text: content,
			},
		});

		await this.docs.documents.batchUpdate({
			documentId,
			requestBody: { requests },
		});

		return {
			id: documentId,
			title: doc.data.title || "Untitled",
			url: `https://docs.google.com/document/d/${documentId}/edit`,
		};
	}

	async appendToDocument(
		documentId: string,
		content: string,
	): Promise<DocumentInfo> {
		const doc = await this.docs.documents.get({ documentId });
		const endIndex = this.getDocumentEndIndex(doc.data);

		await this.docs.documents.batchUpdate({
			documentId,
			requestBody: {
				requests: [
					{
						insertText: {
							location: { index: endIndex },
							text: "\n" + content,
						},
					},
				],
			},
		});

		return {
			id: documentId,
			title: doc.data.title || "Untitled",
			url: `https://docs.google.com/document/d/${documentId}/edit`,
		};
	}

	async listDocuments(
		folderId?: string,
		query?: string,
		limit: number = 20,
	): Promise<DocumentInfo[]> {
		let q = "mimeType='application/vnd.google-apps.document' and trashed=false";

		if (folderId) {
			q += ` and '${folderId}' in parents`;
		}

		if (query) {
			q += ` and name contains '${query}'`;
		}

		const response = await this.drive.files.list({
			q,
			pageSize: limit,
			fields: "files(id, name, createdTime, modifiedTime)",
			orderBy: "modifiedTime desc",
		});

		return (response.data.files || []).map((file) => ({
			id: file.id!,
			title: file.name!,
			url: `https://docs.google.com/document/d/${file.id}/edit`,
			createdTime: file.createdTime || undefined,
			modifiedTime: file.modifiedTime || undefined,
		}));
	}

	async searchDrive(
		query: string,
		fileType: "document" | "spreadsheet" | "presentation" | "any" = "any",
		limit: number = 20,
	): Promise<DriveFile[]> {
		let q = `name contains '${query}' and trashed=false`;

		const mimeTypes: Record<string, string> = {
			document: "application/vnd.google-apps.document",
			spreadsheet: "application/vnd.google-apps.spreadsheet",
			presentation: "application/vnd.google-apps.presentation",
		};

		if (fileType !== "any" && mimeTypes[fileType]) {
			q += ` and mimeType='${mimeTypes[fileType]}'`;
		}

		const response = await this.drive.files.list({
			q,
			pageSize: limit,
			fields:
				"files(id, name, mimeType, createdTime, modifiedTime, webViewLink)",
			orderBy: "modifiedTime desc",
		});

		return (response.data.files || []).map((file) => ({
			id: file.id!,
			name: file.name!,
			mimeType: file.mimeType!,
			url:
				file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
			createdTime: file.createdTime || undefined,
			modifiedTime: file.modifiedTime || undefined,
		}));
	}

	private extractTextContent(doc: docs_v1.Schema$Document): string {
		const content = doc.body?.content || [];
		let text = "";

		for (const element of content) {
			if (element.paragraph) {
				for (const elem of element.paragraph.elements || []) {
					if (elem.textRun?.content) {
						text += elem.textRun.content;
					}
				}
			}
		}

		return text;
	}

	private getDocumentEndIndex(doc: docs_v1.Schema$Document): number {
		const content = doc.body?.content || [];
		let endIndex = 1;

		for (const element of content) {
			if (element.endIndex && element.endIndex > endIndex) {
				endIndex = element.endIndex;
			}
		}

		return endIndex - 1;
	}
}
