// Thin fetch client. Every call carries the active role header (honored by the
// local dev shim; a published deployment ignores it and uses the verified JWT).
// Query keys must include the role so a lens switch refetches rather than
// showing cached admin data in the User lens.

import type { Role } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, role: Role, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "x-explorer-role": role,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export function apiGet<T>(path: string, role: Role): Promise<T> {
  return request<T>(path, role);
}

export function apiPost<T>(path: string, role: Role, body: unknown): Promise<T> {
  return request<T>(path, role, { method: "POST", body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, role: Role, body: unknown): Promise<T> {
  return request<T>(path, role, { method: "PUT", body: JSON.stringify(body) });
}
