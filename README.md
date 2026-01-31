# Google Workspace Agent

A Sekuire AI Agent for managing Google Workspace documents. This agent provides A2A-compatible endpoints for creating, reading, updating, and managing Google Docs.

## Features

- **Create Documents**: Create new Google Docs with titles and initial content
- **Read Documents**: Retrieve and display document content
- **Update Documents**: Replace or modify document content
- **Append Content**: Add content to existing documents
- **List Documents**: Browse documents by folder or search query
- **Search Drive**: Find files across Google Drive

## Prerequisites

- Node.js 22+
- Google Cloud Project with Google Docs and Drive APIs enabled
- OAuth 2.0 credentials (Client ID, Client Secret, Refresh Token)

## Setup

### 1. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing one
3. Enable the following APIs:
   - Google Docs API
   - Google Drive API
4. Create OAuth 2.0 credentials:
   - Go to APIs & Services > Credentials
   - Create OAuth client ID (Desktop application)
   - Download the credentials

### 2. Get Refresh Token

Use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) or run:

```bash
# Using the Google Auth Library to get refresh token
npx google-auth-library
```

### 3. Environment Variables

Create a `.env` file:

```env
# Google OAuth
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REFRESH_TOKEN=your_refresh_token

# Optional: OpenAI for natural language processing
OPENAI_API_KEY=your_openai_key

# Sekuire Configuration
SEKUIRE_WORKSPACE_ID=your_workspace_id
SEKUIRE_API_URL=http://localhost:5556

# Server
PORT=8002
```

### 4. Install Dependencies

```bash
pnpm install
```

### 5. Run the Agent

```bash
# Development mode with hot reload
pnpm dev

# Production mode
pnpm build && pnpm start
```

## Quick Start (Hosted Version)

If you just want to test the deployed version, you can use it right away - no setup required.

We recommend using [Postman](https://www.postman.com/) for testing the API.

### 1. Connect Your Google Account

Open the following URL in your browser:

```
https://google-workspace-agent.sekuire.ai/auth/google
```

You will be redirected to Google's consent screen. Grant access to:
- Google Docs (create, read, update)
- Google Drive (search)
- User info (email, profile)

After authorization, you'll see a confirmation:

```json
{
  "success": true,
  "message": "Google account connected successfully",
  "user": { "userId": "...", "email": "user@example.com" }
}
```

### 2. Send Tasks to the Agent

Once connected, send tasks to the A2A endpoint. Include your email in the context:

**Endpoint:** `POST https://google-workspace-agent.sekuire.ai/a2a/tasks`

```json
{
  "task_id": "task-123",
  "type": "google:docs:create",
  "input": {
    "title": "Meeting Notes",
    "content": "# Meeting Notes\n\nDate: Today"
  },
  "context": {
    "user_email": "user@example.com"
  }
}
```

The `user_email` in the context must match an authorized Google account.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/google` | GET | Start Google OAuth flow |
| `/auth/google/callback` | GET | OAuth callback (handled automatically) |
| `/auth/users` | GET | List connected users |
| `/auth/users/:userId` | DELETE | Remove a connected user |
| `/health` | GET | Health check |
| `/metrics` | GET | Agent metrics |
| `/agent/info` | GET | Agent capabilities |
| `/.well-known/agent.json` | GET | A2A agent card |
| `/a2a/tasks` | POST | Execute A2A tasks |
| `/sekuire/handshake` | POST | Trust protocol handshake |
| `/sekuire/hello` | GET | Protocol discovery |

## A2A Task Types

### Create Document
```json
{
  "task_id": "task-001",
  "type": "google:docs:create",
  "input": {
    "title": "My New Document",
    "content": "Initial content here",
    "folder_id": "optional_folder_id"
  }
}
```

### Read Document
```json
{
  "task_id": "task-002",
  "type": "google:docs:read",
  "input": {
    "document_id": "1abc123..."
  }
}
```

### Update Document
```json
{
  "task_id": "task-003",
  "type": "google:docs:update",
  "input": {
    "document_id": "1abc123...",
    "content": "New content to replace existing"
  }
}
```

### Append to Document
```json
{
  "task_id": "task-004",
  "type": "google:docs:append",
  "input": {
    "document_id": "1abc123...",
    "content": "Content to add at the end"
  }
}
```

### List Documents
```json
{
  "task_id": "task-005",
  "type": "google:docs:list",
  "input": {
    "folder_id": "optional_folder_id",
    "query": "search term",
    "limit": 20
  }
}
```

### Search Drive
```json
{
  "task_id": "task-006",
  "type": "google:drive:search",
  "input": {
    "query": "project report",
    "file_type": "document",
    "limit": 10
  }
}
```

## Example Usage

### Using curl

```bash
# Create a document
curl -X POST http://localhost:8002/a2a/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "task_id": "create-001",
    "type": "google:docs:create",
    "input": {
      "title": "Meeting Notes",
      "content": "# Meeting Notes\n\nDate: Today\n\n## Attendees\n- Alice\n- Bob"
    }
  }'

# List documents
curl -X POST http://localhost:8002/a2a/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "task_id": "list-001",
    "type": "google:docs:list",
    "input": { "limit": 5 }
  }'
```

### From Another Agent (Delegation)

The Slack Agent can delegate document creation to this agent:

```typescript
const result = await delegator.delegate({
  skill: "google:docs:create",
  message: JSON.stringify({
    title: "Slack Thread Summary",
    content: threadContent
  })
});
```

## Development

```bash
# Run tests
pnpm test

# Lint code
pnpm lint

# Format code
pnpm format
```

## License

MIT
