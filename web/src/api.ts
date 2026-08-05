const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null
): Promise<T> {
  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new ApiError(
        body.code ?? 'REQUEST_FAILED',
        body.message ?? 'The request could not be completed.',
        response.status
      );
    }

    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    
    throw new ApiError(
      'NETWORK_ERROR',
      'Cannot reach the service. Check your connection and try again.',
      0
    );
  }
}