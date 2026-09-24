import { randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { authenticateFeishuUser } from "@/src/application/authenticate-feishu-user";
import { createFeishuOAuthClient, FeishuOAuthError } from "@/src/infrastructure/auth/feishu-oauth";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { clearOAuthStateCookie, getCookie, oauthStateCookieName, sessionCookie } from "@/src/server/auth-cookies";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const state = requestUrl.searchParams.get("state");
  const expectedState = getCookie(request, oauthStateCookieName);
  if (!state || !expectedState || !statesMatch(state, expectedState)) {
    return callbackError(request, "invalid_state", 400);
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) return callbackError(request, "missing_code", 400);

  const config = getOAuthConfig();
  if (!config) return callbackError(request, "not_configured", 503);

  try {
    const identity = await createFeishuOAuthClient(config).exchangeCode(code);
    const prisma = getPrisma();
    const employee = await authenticateFeishuUser(identity, {
      employees: {
        findByFeishuUserId: (feishuUserId) => prisma.employee.findUnique({ where: { feishuUserId } }),
        create: ({ feishuUserId, displayName }) => prisma.employee.create({
          data: { id: randomUUID(), feishuUserId, displayName },
        }),
      },
    });

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) throw new Error("session configuration is missing");

    const response = NextResponse.redirect(new URL("/claims", request.url));
    response.headers.append("Set-Cookie", clearOAuthStateCookie(isProduction()));
    response.headers.append("Set-Cookie", sessionCookie(employee.id, sessionSecret, isProduction()));
    return response;
  } catch (error) {
    if (error instanceof FeishuOAuthError) {
      console.error("[feishu-oauth] authentication failed", {
        stage: error.stage,
        providerCode: error.providerCode,
      });
      return callbackError(request, `feishu_${error.stage}_failed`, 502, error.providerCode);
    }
    console.error("[feishu-oauth] authentication failed", { stage: "local" });
    return callbackError(request, "authentication_failed", 502);
  }
}

function statesMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return receivedBuffer.byteLength === expectedBuffer.byteLength && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function getOAuthConfig() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const redirectUri = process.env.FEISHU_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

function getPrisma() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database configuration is missing");
  return createPrismaClient(connectionString);
}

function callbackError(request: Request, reason: string, status: number, providerCode?: string | number) {
  const response = NextResponse.json({
    error: reason,
    ...(isProduction() || providerCode === undefined ? {} : { providerCode }),
  }, { status });
  response.headers.append("Set-Cookie", clearOAuthStateCookie(isProduction()));
  return response;
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}
