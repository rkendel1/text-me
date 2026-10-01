import type { AppPortApplication } from '@appport/core';
import { createMcpHandler, createMcpServer, type McpCallerRequest, type McpHandler, type McpServerOptions } from '@appport/mcp';

import type { Session } from '@appport/protocol';

/**
 * Who is calling, as established by the host's own authentication. The host verifies the credential and
 * resolves the member's account; this module only turns that into the AppPort session the call runs as.
 * Resolves to `undefined` for a request that presented no credential, and throws `unauthorized` for one that
 * presented a bad credential.
 */
export type McpAuthenticator = (headers: McpCallerRequest['headers']) => Promise<Session | undefined>;

/**
 * The MCP projection of the call capabilities: `@appport/mcp`'s own server, unchanged, over the same AppPort
 * application the voice runtime and control plane use. There is no second definition of a call operation here
 * and no MCP protocol implementation: this selects which capabilities are projected (`call.*`) and whose
 * session each tool call runs as. Authorization, idempotency, deadlines and tenant isolation stay in AppPort and
 * in the capability handlers; MCP grants no authority of its own.
 */
function callMcpOptions(authenticate: McpAuthenticator): McpServerOptions {
  return {
    include: (capability) => capability.name.startsWith('call.'),
    async context({ headers }) {
      const session = await authenticate(headers);
      if (!session) return undefined; // anonymous: AppPort refuses every capability that needs a permission
      return { session };
    },
  };
}

/** The Streamable HTTP handler the application mounts. Stateless: a fresh SDK server per request. */
export function createCallMcpHandler(application: AppPortApplication, authenticate: McpAuthenticator): McpHandler {
  return createMcpHandler(application, callMcpOptions(authenticate));
}

/** The same projection as an SDK `Server`, for stdio or in-memory transports (tests). */
export function createCallMcpServer(application: AppPortApplication, authenticate: McpAuthenticator) {
  return createMcpServer(application, callMcpOptions(authenticate));
}
