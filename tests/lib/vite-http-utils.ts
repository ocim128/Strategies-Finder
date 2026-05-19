import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_BODY_BYTES = 80 * 1024 * 1024;

export interface ViteHttpResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body: string | Buffer): void;
}

export class HttpStatusError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "HttpStatusError";
    }
}

export function sendJson(res: ViteHttpResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

export function sendBinary(res: ViteHttpResponse, status: number, payload: Buffer): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(payload);
}

export async function readBodyBuffer(
    req: IncomingMessage,
    maxBytes = DEFAULT_MAX_BODY_BYTES
): Promise<Buffer> {
    const rawContentLength = req.headers["content-length"];
    const contentLength = Array.isArray(rawContentLength)
        ? Number(rawContentLength[0])
        : Number(rawContentLength);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new HttpStatusError(413, `Request body too large. Limit is ${maxBytes} bytes.`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += bytes.length;
        if (total > maxBytes) {
            throw new HttpStatusError(413, `Request body too large. Limit is ${maxBytes} bytes.`);
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const buffer = await readBodyBuffer(req);
    const text = buffer.toString("utf8").trim();
    if (!text) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new HttpStatusError(400, "Invalid JSON body.");
    }
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

export function sendCaughtErrorJson(res: ViteHttpResponse, error: unknown): void {
    if (error instanceof HttpStatusError) {
        sendJson(res, error.status, { ok: false, error: error.message });
        return;
    }

    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, error: message });
}
