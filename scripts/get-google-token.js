// One-time local script: authorizes your Google account and prints the
// GOOGLE_REFRESH_TOKEN to put in .env. Run: npm run get-token
import "dotenv/config";
import fs from "fs";
import http from "http";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README step 2).");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  // Full calendar access: the bot creates its own School/Work/Personal/Deadlines calendars.
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
];

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get("code");
  if (!code) {
    res.end("No code in callback. Try again.");
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end("Done! Go back to the terminal.");
    // Written straight into .env, never printed, so the token can't end up
    // in a terminal log or a chat transcript.
    const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
    const line = `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`;
    const next = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env)
      ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line)
      : `${env.trimEnd()}\n${line}\n`;
    fs.writeFileSync(".env", next);
    console.log("\n✅ Success. New GOOGLE_REFRESH_TOKEN saved into .env (not shown here).\n");
  } catch (err) {
    res.end("Token exchange failed, see terminal.");
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("Open this URL in your browser and approve access:\n");
  console.log(url + "\n");
});
