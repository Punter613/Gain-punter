const BACKEND_ORIGIN = 'https://p613-backend.onrender.com';

export async function onRequest(context) {
  const incoming = context.request;
  const incomingUrl = new URL(incoming.url);
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, BACKEND_ORIGIN);

  const headers = new Headers(incoming.headers);
  headers.delete('host');

  const init = {
    method: incoming.method,
    headers,
    redirect: 'manual'
  };

  if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
    init.body = await incoming.arrayBuffer();
  }

  try {
    return await fetch(targetUrl.toString(), init);
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: 'SKSK backend unavailable',
        detail: error?.message || 'Proxy request failed'
      },
      { status: 502 }
    );
  }
}
