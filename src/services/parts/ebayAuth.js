let cachedToken = null;
let tokenExpiresAt = 0;

async function getEbayToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return { token: cachedToken, marketplace: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US' };
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const marketplace = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  if (!clientId || !clientSecret) {
    throw new Error('Missing eBay credentials');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    })
  });

  if (!response.ok) {
    throw new Error(`eBay token request failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);

  return { token: cachedToken, marketplace };
}

module.exports = { getEbayToken };
