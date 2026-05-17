/**
 * Vitest global setup — sets required env vars before any module imports.
 *
 * Derives a dummy GM private key from the public Anvil/Hardhat test mnemonic
 * (account index 0) instead of hardcoding a key literal. The mnemonic is
 * not a credential — it is the documented default that produces the same
 * deterministic accounts in every Hardhat/Foundry test environment.
 *
 * NEVER replace this with a hex-key literal — see memory/feedback_never_hardcode_pk.
 */
import { mnemonicToAccount } from "viem/accounts";
import { toHex } from "viem";

const ANVIL_TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const acct = mnemonicToAccount(ANVIL_TEST_MNEMONIC, { addressIndex: 0 });
const privateKey = acct.getHdKey().privateKey;
if (!privateKey) {
  throw new Error("Failed to derive private key from test mnemonic");
}
process.env.GM_PRIVATE_KEY = toHex(privateKey);
