export class ApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(`La API respondió HTTP ${status}`);
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}
