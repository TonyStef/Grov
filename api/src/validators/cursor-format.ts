// Cursor data format validation
// Security: Cursor format is structurally different from Proxy format

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CursorExtractRequest {
  composerId: string;
  usageUuid: string;
  mode: 'ask' | 'plan' | 'agent';
  projectPath: string;
  original_query: string;
  text: string;
  thinking: string;
  toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateCursorFormat(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Body must be an object' };
  }

  const data = body as Record<string, unknown>;

  // Required UUID fields
  if (typeof data.composerId !== 'string' || !UUID_REGEX.test(data.composerId)) {
    return { valid: false, error: 'composerId must be a valid UUID' };
  }

  if (typeof data.usageUuid !== 'string' || !UUID_REGEX.test(data.usageUuid)) {
    return { valid: false, error: 'usageUuid must be a valid UUID' };
  }

  // Mode validation
  if (!['ask', 'plan', 'agent'].includes(data.mode as string)) {
    return { valid: false, error: 'mode must be ask, plan, or agent' };
  }

  // Required string fields
  if (typeof data.projectPath !== 'string' || !data.projectPath) {
    return { valid: false, error: 'projectPath is required' };
  }

  if (typeof data.original_query !== 'string' || !data.original_query) {
    return { valid: false, error: 'original_query is required' };
  }

  if (typeof data.text !== 'string') {
    return { valid: false, error: 'text is required' };
  }

  if (typeof data.thinking !== 'string') {
    return { valid: false, error: 'thinking is required' };
  }

  // toolCalls validation
  if (!Array.isArray(data.toolCalls)) {
    return { valid: false, error: 'toolCalls must be an array' };
  }

  for (const tool of data.toolCalls) {
    if (typeof tool !== 'object' || !tool) {
      return { valid: false, error: 'Each toolCall must be an object' };
    }
    if (typeof (tool as Record<string, unknown>).name !== 'string') {
      return { valid: false, error: 'Each toolCall must have a name' };
    }
  }

  // Reject proxy-specific fields (security)
  const proxyFields = ['sessionId', 'steps', 'triggerReason', 'sessionState'];
  for (const field of proxyFields) {
    if (field in data) {
      return { valid: false, error: `Invalid field: ${field}` };
    }
  }

  return { valid: true };
}

export function parseCursorRequest(body: unknown): CursorExtractRequest {
  const data = body as Record<string, unknown>;
  return {
    composerId: data.composerId as string,
    usageUuid: data.usageUuid as string,
    mode: data.mode as 'ask' | 'plan' | 'agent',
    projectPath: data.projectPath as string,
    original_query: data.original_query as string,
    text: data.text as string,
    thinking: data.thinking as string,
    toolCalls: data.toolCalls as Array<{ name: string; params: Record<string, unknown> }>,
  };
}
