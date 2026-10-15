import { web3 } from "@anchor-lang/core";
import { MolphaSDK, DEFAULT_GATEWAY_ENDPOINT, type GatewayEndpointInput } from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";
import { expandHome, type Env } from "./config.js";

export interface Molpha {
  sdk: MolphaSDK;
  connection: web3.Connection;
  payer: web3.PublicKey;
}

export function createMolpha(env: Env): Molpha {
  const connection = new web3.Connection(env.rpcUrl, {
    commitment: env.commitment,
    wsEndpoint: env.wsUrl,
  });
  const wallet = walletFromKeypairFile(expandHome(env.keypairPath));
  let endpoints: GatewayEndpointInput | undefined;
  if (env.gatewayUrl) {
    endpoints = env.gatewayAuthority
      ? { url: env.gatewayUrl, gatewayAuthority: env.gatewayAuthority }
      : env.gatewayUrl;
  }
  const sdk = new MolphaSDK({
    connection,
    wallet,
    endpoints: endpoints ?? DEFAULT_GATEWAY_ENDPOINT,
    commitment: env.commitment,
  });
  return { sdk, connection, payer: wallet.publicKey };
}
