import type { Connection } from "@lithis/core";
import type { Connector } from "@lithis/sdk/connectors";
import type { ConnectorAuthProvider, ConnectorFactory, ConnectorRuntime, HealthProbe } from "./index";

/**
 * The ConnectorRuntime seam: connector implementations (extensions/connectors,
 * built in the C-* phases) register here by slug; the sync loop and the
 * registry's health probes resolve through it. Factory registrations receive
 * the ConnectorAuthProvider — the ONLY sanctioned path to authenticated calls:
 * custody mints a BrokeredAuth (opaque brokerToken, never the secret) and the
 * provider redeems the token for the actual header/token at call time, inside
 * server-side connector code.
 */
export function createConnectorRuntime(auth: ConnectorAuthProvider): ConnectorRuntime {
  const connectors = new Map<string, Connector>();
  return {
    register(input: Connector | ConnectorFactory): Connector {
      const connector = typeof input === "function" ? input(auth) : input;
      const slug = connector.manifest.slug;
      if (connectors.has(slug)) {
        throw new Error(`connector '${slug}' is already registered in this runtime`);
      }
      connectors.set(slug, connector);
      return connector;
    },
    resolve(slug: string): Connector | undefined {
      return connectors.get(slug);
    },
    slugs(): string[] {
      return [...connectors.keys()].sort();
    },
    probeFor(connection: Connection): HealthProbe | undefined {
      const connector = connectors.get(connection.connectorSlug);
      if (connector === undefined) return undefined;
      return { probe: (c) => connector.health(c) };
    },
  };
}
