import { serializeJsonPreservingNonFinite } from "./json-utils";

export interface HttpResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body: string): void;
}

export function sendJson(res: HttpResponseLike, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(serializeJsonPreservingNonFinite(payload));
}
