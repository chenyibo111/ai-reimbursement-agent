import { randomUUID } from "node:crypto";

export type RequestContext = {
  requestId: string;
};

type RequestHandler = (context: RequestContext) => Response | Promise<Response>;

const validRequestId = /^[a-zA-Z0-9_-]{1,128}$/;

export function getRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && validRequestId.test(supplied) ? supplied : randomUUID();
}

export async function withRequestContext(request: Request, handler: RequestHandler): Promise<Response> {
  const context = { requestId: getRequestId(request) };
  const response = await handler(context);
  response.headers.set("x-request-id", context.requestId);
  return response;
}
