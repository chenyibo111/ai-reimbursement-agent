/**
 * Small fetch helper for API-boundary tests. UI tests normally mock the typed
 * client; client tests can use this utility without coupling to a database.
 */
export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}
