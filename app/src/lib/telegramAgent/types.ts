export type TgChat = {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
};

export type TgFrom = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TgVoice = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
};

export type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgFrom;
  text?: string;
  voice?: TgVoice;
  date: number;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
};

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ConversationMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AgentUser = {
  userId: string;
  fullName: string;
  role: string;
  email: string;
  telegramId: number;
};

export type LlmResponse = {
  content: string | null;
  toolCalls: ToolCall[];
};

export type ToolHandler = (params: Record<string, unknown>) => Promise<string>;

export type WriteToolHandler = (params: Record<string, unknown>, user: AgentUser) => Promise<string>;
