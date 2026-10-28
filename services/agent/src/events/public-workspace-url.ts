/** Only publish links that a Feishu user can open outside the developer's machine. */
export function publicWorkspaceUrl(baseUrl: string, claimId?: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase())) return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/claims${claimId ? `/${encodeURIComponent(claimId)}` : ""}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
