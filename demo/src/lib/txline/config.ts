// TxLINE relayer config. Server-only — never import from a "use client" module.
//
// Auth model (from TxLINE OpenAPI, components/securitySchemes):
//   - httpAuth  : Bearer {guest JWT}   -> from POST /auth/guest/start (30-day expiry)
//   - apiKeyAuth: X-Api-Token {token}  -> from POST /api/token/activate (long-lived)
// Both headers are required on every data endpoint.
//
// The guest JWT + API token are provisioned ONCE, out of band, by scripts/txline-activate.ts
// (guest/start -> on-chain subscribe -> sign -> activate) and dropped into these env vars. The
// runtime relayer never subscribes; it just carries the tokens. Tokens stay server-side so the
// browser never sees them (same posture as RPC_URL in api/book/route.ts).

export type TxNetwork = "devnet" | "mainnet";

const HOSTS: Record<TxNetwork, string> = {
  // /auth/guest/start lives at host root; data endpoints live under /api.
  devnet: "https://txline-dev.txodds.com",
  mainnet: "https://txline.txodds.com",
};

export interface TxlineConfig {
  network: TxNetwork;
  host: string;
  guestJwt: string; // Bearer token (httpAuth)
  apiToken: string; // X-Api-Token (apiKeyAuth)
}

/** Read + validate relayer config from the environment. Throws a clear error if unprovisioned. */
export function txlineConfig(): TxlineConfig {
  const network = (process.env.TXLINE_NETWORK as TxNetwork) || "devnet";
  const host = process.env.TXLINE_HOST || HOSTS[network];
  const guestJwt = process.env.TXLINE_GUEST_JWT || "";
  const apiToken = process.env.TXLINE_API_TOKEN || "";
  if (!guestJwt || !apiToken) {
    throw new Error(
      "TxLINE not provisioned: set TXLINE_GUEST_JWT and TXLINE_API_TOKEN " +
        "(run `npx tsx scripts/txline-activate.ts` to generate them).",
    );
  }
  return { network, host, guestJwt, apiToken };
}

export const authUrl = (host: string, path: string) => `${host}${path}`; // e.g. /auth/guest/start
export const apiUrl = (host: string, path: string) => `${host}/api${path}`; // e.g. /odds/snapshot/123
