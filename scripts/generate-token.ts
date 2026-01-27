#!/usr/bin/env tsx
import "dotenv/config";
import { createServer } from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";
import { GOOGLE_SCOPES } from "../src/google-auth.js";

const REDIRECT_PORT = 3000;

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
    console.error("");
    console.error("Setup steps:");
    console.error("1. Go to https://console.cloud.google.com/apis/credentials");
    console.error("2. Create OAuth 2.0 credentials (Web application)");
    console.error("3. Add http://localhost:3000/oauth/callback to authorized redirect URIs");
    console.error("4. Enable Google Docs API and Google Drive API");
    console.error("5. Add credentials to your .env file");
    process.exit(1);
  }

  const redirectUri = `http://localhost:${REDIRECT_PORT}/oauth/callback`;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: GOOGLE_SCOPES,
    prompt: "consent",
  });

  console.log("\n=== Google OAuth Token Generator ===\n");
  console.log("This script helps you test the OAuth flow locally.\n");
  console.log("Scopes requested:");
  for (const scope of GOOGLE_SCOPES) {
    console.log(`  - ${scope}`);
  }
  console.log("\n1. Open this URL in your browser:\n");
  console.log(`   ${authUrl}\n`);
  console.log("2. Sign in and grant permissions");
  console.log("3. You will be redirected back here\n");

  const code = await waitForAuthCode();
  console.log("Exchanging code for tokens...\n");

  const { tokens } = await oauth2Client.getToken(code);

  console.log("=== SUCCESS ===\n");
  console.log("User info:");

  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  console.log(`  Email: ${data.email}`);
  console.log(`  ID: ${data.id}`);
  console.log("");

  if (tokens.refresh_token) {
    console.log("Refresh token (for manual testing):");
    console.log(`  ${tokens.refresh_token}\n`);
  }

  console.log("In production, users connect via: http://localhost:8002/auth/google");
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname === "/oauth/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><p>${error}</p>`);
          server.close();
          reject(new Error(error));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Success!</h1><p>You can close this window and return to the terminal.</p>");
          server.close();
          resolve(code);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Callback server listening on port ${REDIRECT_PORT}`);
    });

    server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`Port ${REDIRECT_PORT} is in use.`);
      }
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
