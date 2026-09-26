/** Spec command vocabulary for the owner's control-plane actions. */
export type RuntimeCommandType =
  | 'start'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'take_over'
  | 'return_to_assistant'
  | 'interrupt'
  | 'adjust_interaction'
  | 'transition_to_text'
  | 'answer_owner_request'
  | 'owner_message';

/**
 * accepted → applied (runtime state persisted) → applied_live (the live call
 * acted on it); or rejected. `noop` means the runtime was already in that state.
 */
export type RuntimeCommandStatus = 'accepted' | 'applied' | 'applied_live' | 'noop' | 'rejected';

export interface RuntimeCommand {
  id: string;
  conversationId: string;
  /** The conversation's runtime; one runtime per conversation, versioned by revision. */
  runtimeId: string;
  ownerId: string;
  type: RuntimeCommandType;
  payload: Record<string, unknown>;
  status: RuntimeCommandStatus;
  error?: string;
  createdAt: Date;
  processedAt?: Date;
  appliedLiveAt?: Date;
}

export interface RuntimeCommandStore {
  record(command: RuntimeCommand): Promise<void>;
  update(id: string, patch: Pick<RuntimeCommand, 'status'> & Partial<Pick<RuntimeCommand, 'error' | 'processedAt' | 'appliedLiveAt'>>): Promise<void>;
  list(conversationId: string): Promise<RuntimeCommand[]>;
  get(id: string): Promise<RuntimeCommand | null>;
}

export const runtimeIdFor = (conversationId: string) => `rt_${conversationId.replace(/^conv_/, '')}`;

export class InMemoryRuntimeCommandStore implements RuntimeCommandStore {
  private readonly commands = new Map<string, RuntimeCommand>();

  async record(command: RuntimeCommand): Promise<void> {
    if (!this.commands.has(command.id)) this.commands.set(command.id, structuredClone(command));
  }

  async update(id: string, patch: Parameters<RuntimeCommandStore['update']>[1]): Promise<void> {
    const command = this.commands.get(id);
    if (!command) return;
    const status = command.status === 'applied_live' && patch.status === 'applied' ? command.status : patch.status;
    this.commands.set(id, { ...command, ...structuredClone(patch), status });
  }

  async get(id: string): Promise<RuntimeCommand | null> {
    return structuredClone(this.commands.get(id) ?? null);
  }

  async list(conversationId: string): Promise<RuntimeCommand[]> {
    return [...this.commands.values()]
      .filter((command) => command.conversationId === conversationId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((command) => structuredClone(command));
  }
}
