'use strict';

// Usage: node scripts/get-google-refresh-token.js CLIENT_ID CLIENT_SECRET
// Lance un serveur local sur :3456 pour capter le callback OAuth

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];
const REDIRECT_URI = 'http://localhost:3456/oauth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/get-google-refresh-token.js CLIENT_ID CLIENT_SECRET');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.file'],
  prompt: 'consent',
});

console.log('\n1. Ouvre cette URL dans ton navigateur :');
console.log('\n' + authUrl + '\n');
console.log('2. Autorise l\'accès avec ton compte Google...\n');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.includes('/oauth/callback') || !parsed.query.code) {
    res.end('En attente du callback...');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(parsed.query.code);

    console.log('\n✅ Refresh token obtenu !\n');
    console.log('Ajoute ces 3 variables dans Render (et supprime GOOGLE_SERVICE_ACCOUNT_JSON) :\n');
    console.log('GOOGLE_OAUTH_CLIENT_ID=' + CLIENT_ID);
    console.log('GOOGLE_OAUTH_CLIENT_SECRET=' + CLIENT_SECRET);
    console.log('GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>✅ Succès !</h1><p>Le refresh token est affiché dans ton terminal. Tu peux fermer cet onglet.</p>');
  } catch (e) {
    console.error('Erreur:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Erreur</h1><p>' + e.message + '</p>');
  }

  server.close();
});

server.listen(3456, () => {
  console.log('Serveur OAuth en attente sur http://localhost:3456 ...');
});
