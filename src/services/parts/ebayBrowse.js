const { getEbayToken } = require('./ebayAuth');

async function searchEbayParts(query, limit = 3) {
  const { token, marketplace } = await getEbayToken();

  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplace
    }
  });

  if (!response.ok) {
    throw new Error(`eBay browse search failed: ${response.status}`);
  }

  return response.json();
}

module.exports = { searchEbayParts };
