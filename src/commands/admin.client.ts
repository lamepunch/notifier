import { Singleton } from "stratal/di";

const LOCAL_URL = "http://localhost:8787";
const REMOTE_URL = "https://notifier.grenuttag.workers.dev";
const LOCAL_TOKEN_ENV = "NOTIFIER_ADMIN_TOKEN";
const REMOTE_TOKEN_ENV = "NOTIFIER_REMOTE_ADMIN_TOKEN";
const ERROR_BODY_PREVIEW_LENGTH = 200;

@Singleton()
export class AdminClient {
  async request(
    remote: boolean,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const baseUrl = remote ? REMOTE_URL : LOCAL_URL;
    const tokenName = remote ? REMOTE_TOKEN_ENV : LOCAL_TOKEN_ENV;
    const token = process.env[tokenName];
    if (!token) {
      throw new Error(
        `${tokenName} is not set (export it or add it to the environment)`,
      );
    }

    const method = init.method ?? "GET";
    const url = new URL(path, baseUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Keep non-JSON responses available to callers and error messages.
    }

    if (!response.ok) {
      const detail =
        data && typeof data === "object" && "message" in data
          ? String(data.message)
          : text.slice(0, ERROR_BODY_PREVIEW_LENGTH);
      throw new Error(
        `${method} ${url.pathname} failed: ${response.status} ${detail}`,
      );
    }

    return data;
  }
}
