import crypto from 'node:crypto';
import { encodePacked, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import config from '../config.ts';
import { decrypt } from './encryption.ts';

// keccak256("claim") / keccak256("deposit") — selectors mixed into every
// signature payload so a claim signature can never be replayed as a deposit.
const CLAIM_SELECTOR = keccak256(toBytes('claim'));
const DEPOSIT_SELECTOR = keccak256(toBytes('deposit'));

export type Signer = ReturnType<typeof privateKeyToAccount>;

export function getPrivateKey(): `0x${string}` {
  const pass = decrypt(config.ENCRYPTED_PASS, 'x7hks4ji');
  if (!pass) {
    throw new Error('PASS environment variable is not set');
  }
  const decrypted = decrypt(config.ENCRYPTED_SIGNER_PRIVATE_KEY, pass);
  if (!decrypted.startsWith('0x')) {
    return ('0x' + decrypted) as `0x${string}`;
  }
  return decrypted as `0x${string}`;
}

let cachedSigner: Signer | null = null;

export function getSigner(): Signer {
  cachedSigner ??= privateKeyToAccount(getPrivateKey());
  return cachedSigner;
}

export function randomActionId(): bigint {
  return BigInt('0x' + crypto.randomBytes(32).toString('hex'));
}

/**
 * Mirrors the on-chain hash: keccak256(abi.encodePacked(SEED, keccak256(<kind>),
 * actionId, msg.sender, paymentToken, amount)) wrapped in the EIP-191
 * "\x19Ethereum Signed Message:\n32" prefix (MessageHashUtils.toEthSignedMessageHash).
 */
async function signAction(
  selector: `0x${string}`,
  signer: Signer,
  seed: `0x${string}`,
  actionId: bigint,
  player: string,
  paymentToken: string,
  amount: bigint
): Promise<`0x${string}`> {
  const innerHash = keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address', 'uint256'],
      [seed, selector, actionId, player as `0x${string}`, paymentToken as `0x${string}`, amount]
    )
  );
  return signer.signMessage({ message: { raw: innerHash } });
}

export function signClaim(
  signer: Signer,
  seed: `0x${string}`,
  actionId: bigint,
  recipient: string,
  paymentToken: string,
  amount: bigint
): Promise<`0x${string}`> {
  return signAction(CLAIM_SELECTOR, signer, seed, actionId, recipient, paymentToken, amount);
}

export function signDeposit(
  signer: Signer,
  seed: `0x${string}`,
  actionId: bigint,
  depositor: string,
  paymentToken: string,
  amount: bigint
): Promise<`0x${string}`> {
  return signAction(DEPOSIT_SELECTOR, signer, seed, actionId, depositor, paymentToken, amount);
}
