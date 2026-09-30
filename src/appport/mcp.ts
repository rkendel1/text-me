import type { AppPortApplication } from '@appport/core';
import type { Session } from '@appport/protocol';
import { createMcpBridge, type McpBridge } from '@appport/mcp';

/**
 * The MCP projection of the call capabilities: `@appport/mcp`'s own bridge, unchanged, over the
 * same AppPort application. There is no second definition of a call operation here, and no MCP
 * protocol implementation: this only selects which capabilities are projected (`call.*`) and whose
 * session the tool calls run as. Wiring the bridge into an MCP server transport is a separate step.
 */
export function createCallMcpBridge(application: AppPortApplication, session: Session): McpBridge {
  return createMcpBridge(application, { session }, { include: (capability) => capability.name.startsWith('call.') });
}
