// Novita API request and response type definitions
// Novita uses OpenAI-compatible endpoints

export interface NovitaRequestBody {
  model: string;
  messages: NovitaMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: NovitaTool[];
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

export type NovitaMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: string; text?: string }> }
  | { role: 'assistant'; content?: string | Array<{ type: string; text?: string }>; tool_calls?: NovitaToolCall[] }
  | { type: 'tool_result'; tool_call_id: string; content: string };

export interface NovitaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface NovitaResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: NovitaChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface NovitaChoice {
  index: number;
  message: NovitaMessage;
  finish_reason?: string;
}

export interface NovitaToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
