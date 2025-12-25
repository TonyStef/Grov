// Shared types for Grov proxy

export interface MessagesRequestBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string | Array<{ type: string; text: string }>;
  max_tokens?: number;
  tools?: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
