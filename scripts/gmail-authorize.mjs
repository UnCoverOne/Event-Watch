import http from 'node:http';
import { URL } from 'node:url';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your shell before running this script.');
  process.exit(1);
}

const redirectUri = 'http://127.0.0.1:53682/oauth2/callback';
const scope = 'https://www.googleapis.com/auth/gmail.send';

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\nOpen this URL in your browser and authorize Event Watch:\n');
console.log(authUrl.toString());
console.log('\nWaiting for Google to redirect back to this computer...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/oauth2/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error || !code) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Authorization failed: ${error || 'missing authorization code'}`);
    server.close();
    return;
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const payload = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(JSON.stringify(payload));
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Event Watch authorized</h1><p>You can close this tab and return to PowerShell.</p>');

    console.log('Authorization succeeded.\n');
    if (payload.refresh_token) {
      console.log('GOOGLE_REFRESH_TOKEN=');
      console.log(payload.refresh_token);
      console.log('\nStore this value as a Cloudflare secret. Do not commit it to Git.');
    } else {
      console.log('Google did not return a refresh token.');
      console.log('Remove Event Watch access from your Google Account and run this script again.');
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Token exchange failed. Check PowerShell for details.');
    console.error('Token exchange failed:', err);
  } finally {
    server.close();
  }
});

server.listen(53682, '127.0.0.1');
