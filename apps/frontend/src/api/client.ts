import { forceLogout, getAuthToken } from '../auth/session';

type RequestOptions = RequestInit & {
  skipAuth?: boolean;
  tokenOverride?: string | null;
};

type ApiError = Error & {
  status?: number;
  code?: string;
  rawBody?: string;
};

const API_BASE = '/api';

async function request<T>(input: RequestInfo | URL, options: RequestOptions = {}): Promise<T> {
  const { skipAuth, tokenOverride, headers: initHeaders, body, ...rest } = options;
  const headers: Record<string, string> = {};

  if (!(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (initHeaders) {
    Object.assign(headers, initHeaders as Record<string, string>);
  }

  const authToken = tokenOverride ?? (skipAuth ? null : getAuthToken());
  const hasAuthToken = Boolean(authToken);
  if (authToken) {
    headers.Authorization = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
  }

  const response = await fetch(input, {
    ...rest,
    body:
      body instanceof FormData || typeof body === 'string'
        ? body
        : body
          ? JSON.stringify(body)
          : undefined,
    headers,
  });

  if (response.status === 401) {
    if (hasAuthToken) {
      forceLogout();
    }
    const error: ApiError = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    // An empty-bodied 5xx never comes from the API itself (Nest always sends a
    // JSON body). It means the request died before reaching the backend — the
    // dev proxy answers ECONNREFUSED with a bodyless 500 while the server boots.
    const unreachable = response.status >= 500 && !text.trim();
    const apiError: ApiError = new Error(
      unreachable
        ? 'Cannot reach the server. It may still be starting — try again in a moment.'
        : text || response.statusText,
    );
    apiError.status = response.status;
    apiError.rawBody = text;
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.message === 'string') {
          apiError.message = parsed.message;
        } else if (typeof parsed.error === 'string') {
          apiError.message = parsed.error;
        }
        if (typeof parsed.code === 'string') {
          apiError.code = parsed.code;
        } else if (typeof parsed.errorCode === 'string') {
          apiError.code = parsed.errorCode;
        }
      } catch {
        // not JSON, keep defaults
      }
    }
    throw apiError;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const apiClient = {
  get<T>(path: string, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, options);
  },
  post<T, B = unknown>(path: string, body?: B, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'POST',
      body: body as RequestOptions['body'],
      ...options,
    });
  },
  put<T, B = unknown>(path: string, body?: B, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'PUT',
      body: body as RequestOptions['body'],
      ...options,
    });
  },
  patch<T, B = unknown>(path: string, body?: B, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'PATCH',
      body: body as RequestOptions['body'],
      ...options,
    });
  },
  delete<T>(path: string, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'DELETE',
      ...options,
    });
  },
  upload<T>(path: string, formData: FormData, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'POST',
      body: formData,
      ...options,
    });
  },
};
