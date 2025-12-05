/**
 * Common API types - shared request/response patterns
 */

// Standard error response
export interface ApiError {
  error: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

// Pagination params
export interface PaginationParams {
  limit?: number;
  cursor?: string;
}

// Paginated response wrapper
export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null;
  has_more: boolean;
}

// Success response wrapper
export interface SuccessResponse<T = void> {
  success: true;
  data?: T;
}

// Standard API response
export type ApiResponse<T> = SuccessResponse<T> | ApiError;
