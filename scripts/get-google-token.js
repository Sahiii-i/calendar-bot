// One-time local script: authorizes your Google account and prints the
// GOOGLE_REFRESH_TOKEN to put in .env. Run: npm run get-token
import "dotenv/config";
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
  "https://www.googleapis.com/auth/calendar.events",
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
    console.log("\n✅ Success. Add this line to your .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
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
