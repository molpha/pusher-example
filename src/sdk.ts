import { web3 } from "@anchor-lang/core";
import {
  MolphaSDK,
  PlanType,
  DEFAULT_GATEWAY_ENDPOINT,
  type GatewayEndpointInput,
} from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";
import { expandHome, type Env } from "./config.js";

const SEND_ONLY = Symbol.for("molpha.pusher.sendOnly");
const UNSET_BLOCKHASH = "11111111111111111111111111111111";

type SendProvider = {
  opts?: {
    preflightCommitment?: web3.Commitment;
    skipPreflight?: boolean;
    maxRetries?: number;
    minContextSlot?: number;
  };
  connection: web3.Connection;
  wallet: {
    publicKey: web3.PublicKey;
    signTransaction<T extends web3.Transaction | web3.VersionedTransaction>(tx: T): Promise<T>;
  };
  sendAndConfirm: (
    tx: web3.Transaction | web3.VersionedTransaction,
    signers?: web3.Signer[],
    opts?: SendProvider["opts"],
  ) => Promise<string>;
  [SEND_ONLY]?: boolean;
};

export interface Molpha {
  sdk: MolphaSDK;
  connection: web3.Connection;
  payer: web3.PublicKey;
}

/**
 * Ensure the payer wallet has an active Molpha subscription before spending rounds.
 * Subscribes to the Basic plan when no on-chain subscription account exists (debiting USDC).
 */
export async function ensureSubscription(sdk: MolphaSDK, payer: web3.PublicKey): Promise<void> {
  const sub = await sdk.solana.readSubscription(payer);
  if (sub) return;

  const plan = await sdk.solana.getPlan(PlanType.Basic);
  const priceUsdc = Number(plan.subscriptionPrice) / 1e6;
  console.log(
    `No Molpha subscription for ${payer.toBase58()}; subscribing to Basic (${priceUsdc} USDC)…`,
  );
  const { signature, pricePaid } = await sdk.solana.subscribe(PlanType.Basic, {
    maxPriceUsdc: plan.subscriptionPrice,
  });
  console.log(
    `Subscribed (${signature}); paid ${Number(pricePaid) / 1e6} USDC (${plan.maxRounds} rounds per term).`,
  );
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

/**
 * Make the SDK's submit path return when the transaction has been broadcast.
 * Confirmation stays with the caller: the feed lane waits for `processed`, and the
 * configured commitment is observed separately. Preflight still runs, against
 * `processed`, so a stale update is refused before a second signature exists.
 */
export function sendWithoutConfirm(sdk: MolphaSDK): void {
  const provider = (sdk.solana as unknown as { provider?: SendProvider }).provider;
  if (!provider?.sendAndConfirm || provider[SEND_ONLY]) return;
  provider[SEND_ONLY] = true;
  provider.sendAndConfirm = async (tx, signers, opts) => {
    if (tx instanceof web3.VersionedTransaction) {
      if (signers?.length) tx.sign(signers);
    } else {
      tx.feePayer = tx.feePayer ?? provider.wallet.publicKey;
      if (!tx.recentBlockhash || tx.recentBlockhash === UNSET_BLOCKHASH) {
        tx.recentBlockhash = (await provider.connection.getLatestBlockhash("processed")).blockhash;
      }
      for (const signer of signers ?? []) tx.partialSign(signer);
    }
    const signed = await provider.wallet.signTransaction(tx);
    return provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: opts?.skipPreflight ?? provider.opts?.skipPreflight,
      preflightCommitment: "processed",
      maxRetries: opts?.maxRetries ?? provider.opts?.maxRetries,
      minContextSlot: opts?.minContextSlot ?? provider.opts?.minContextSlot,
    });
  };
}
