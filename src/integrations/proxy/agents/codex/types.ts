// Codex API request and response type definitions

export interface CodexRequestBody {
  model: string;
  instructions?: string;
  input: CodexInputItem[];
  previous_response_id?: string;
  stream?: boolean;
  tools?: CodexTool[];
  parallel_tool_calls?: boolean;
}

export type CodexInputItem =
  | { role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string;[key: string]: unknown }> }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface CodexTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CodexResponse {
  id: string;
  status: 'completed' | 'failed' | 'in_progress';
  output: CodexOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
}

export type CodexOutputItem =
  | { type: 'message'; role: 'assistant'; content: CodexMessageContent[] }
  | CodexFunctionCall;

export interface CodexMessageContent {
  type: 'output_text';
  text: string;
}

export interface CodexFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface ShellArguments {
  command: string[];
  workdir: string;
  timeout?: number;
}
