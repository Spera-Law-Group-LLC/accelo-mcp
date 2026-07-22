import dotenv from 'dotenv';
dotenv.config();

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const publicBaseUrl = req('PUBLIC_BASE_URL').replace(/\/$/, '');

export const config = {
  acceloClientId: req('ACCELO_CLIENT_ID'),
  acceloClientSecret: req('ACCELO_CLIENT_SECRET'),
  acceloBaseUrl: (process.env.ACCELO_BASE_URL || 'https://spera.api.accelo.com/api/v0').replace(/\/$/, ''),
  acceloOAuthUrl: (process.env.ACCELO_OAUTH_URL || 'https://spera.api.accelo.com/oauth2/v0').replace(/\/$/, ''),
  publicBaseUrl,
  redirectUri: process.env.OAUTH_REDIRECT_URI || `${publicBaseUrl}/oauth/callback`,
  scope: process.env.OAUTH_SCOPE || 'read(all) write(all)',
  tokenDbPath: process.env.TOKEN_DB_PATH || './data/tokens.db',
  port: parseInt(process.env.PORT || '8787', 10),
  // Browser automation service (accelo-bot).
  // Key is required; if unset trigger_quote_template returns a soft error.
  automationUrl: process.env.AUTOMATION_URL || 'https://ai.speralaw.com/automations/accelo',
  automationKey: process.env.AUTOMATION_KEY || '',
};
