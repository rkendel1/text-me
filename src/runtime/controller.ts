import type { ConversationRuntime } from '../domain/runtime.js';

export interface ConversationRuntimeController {
  start(conversationId: string): Promise<void>;
  stop(conversationId: string): Promise<void>;
  pause(conversationId: string): Promise<void>;
  resume(conversationId: string): Promise<void>;
  interrupt(conversationId: string): Promise<void>;
  update(conversationId: string, config: ConversationRuntime): Promise<void>;
}

export class InProcessConversationRuntimeController implements ConversationRuntimeController {
  async start(_conversationId: string): Promise<void> {}
  async stop(_conversationId: string): Promise<void> {}
  async pause(_conversationId: string): Promise<void> {}
  async resume(_conversationId: string): Promise<void> {}
  async interrupt(_conversationId: string): Promise<void> {}
  async update(_conversationId: string, _config: ConversationRuntime): Promise<void> {}
}
