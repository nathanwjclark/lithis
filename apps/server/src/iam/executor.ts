import type { ActionIntent, Ulid } from "@lithis/core";
import type { ConnectionRegistry, ConnectorAuthProvider, ConnectorRuntime } from "../connections";
import type { ActionExecutionResult, ActionExecutor } from "./actions";

/**
 * The production ActionExecutor: an approved ActionIntent's `capability` names
 * exactly one registered connector action (manifests declare
 * `{ key, capability }`), so execution is a lookup, not a routing table —
 * resolve the connector, find the tenant's connection for it, mint brokered
 * auth through custody, and call `connector.act` with the intent id so the
 * receipt carries full provenance.
 *
 * Everything ambiguous fails loudly: no connector for the capability, no
 * connection, or more than one candidate connection are all errors, never a
 * best guess about who to contact on whose behalf.
 */

export interface ConnectorActionExecutorDeps {
  runtime: ConnectorRuntime;
  connections: Pick<ConnectionRegistry, "findByConnector">;
  auth: ConnectorAuthProvider;
}

interface CapabilityTarget {
  connectorSlug: string;
  actionKey: string;
}

/** Find the single connector action declaring `capability`. */
export function resolveCapability(
  runtime: ConnectorRuntime,
  capability: string,
): CapabilityTarget {
  const matches: CapabilityTarget[] = [];
  for (const slug of runtime.slugs()) {
    const connector = runtime.resolve(slug);
    if (connector === undefined) continue;
    for (const action of connector.manifest.actions) {
      if (action.capability === capability) {
        matches.push({ connectorSlug: slug, actionKey: action.key });
      }
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `no registered connector declares the capability '${capability}' — the action cannot execute`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `capability '${capability}' is declared by ${matches.length} connectors ` +
        `(${matches.map((m) => m.connectorSlug).join(", ")}) — refusing to guess which one acts`,
    );
  }
  return matches[0]!;
}

export function createConnectorActionExecutor(
  deps: ConnectorActionExecutorDeps,
): ActionExecutor {
  return {
    async execute({
      tenantId,
      intent,
    }: {
      tenantId: Ulid;
      intent: ActionIntent;
    }): Promise<ActionExecutionResult> {
      const target = resolveCapability(deps.runtime, intent.capability);
      const connector = deps.runtime.resolve(target.connectorSlug)!;
      const candidates = await deps.connections.findByConnector(target.connectorSlug, tenantId);
      if (candidates.length === 0) {
        throw new Error(
          `no live '${target.connectorSlug}' connection in tenant ${tenantId} — ` +
            `connect one before approving '${intent.capability}' actions`,
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          `tenant ${tenantId} has ${candidates.length} live '${target.connectorSlug}' connections — ` +
            `per-connection action routing lands with the policy layer; refusing to guess`,
        );
      }
      const connection = candidates[0]!;
      const brokered = await deps.auth.getAuth(connection);
      const receipt = await connector.act(
        connection,
        { key: target.actionKey, params: intent.params, intentId: intent.id },
        brokered,
      );
      return {
        ok: receipt.ok,
        ...(receipt.externalId !== undefined ? { externalId: receipt.externalId } : {}),
        ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
      };
    },
  };
}
