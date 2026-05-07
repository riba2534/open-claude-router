export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
}

export function createApiError(
  message: string,
  statusCode = 500,
  code = "internal_error",
  type = "api_error",
): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  error.type = type;
  return error;
}
