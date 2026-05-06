// Stress test — one-time setup: register N test users and save their tokens.
//
// Run:
//   node --experimental-strip-types src/stress/setup.ts
//
// Output is written to src/stress/tokens.json (add to .gitignore).
//
// Re-running registers a fresh batch (new wallets) and overwrites the file.

import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { SiweMessage } from 'siwe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE_URL = 'http://localhost:3000';
const USER_COUNT = 1000;
const SIGNUP_CONCURRENCY = 25;
const SIWE_DOMAIN = 'localhost';
const SIWE_CHAIN_ID = 1;
const OUT_FILE = path.resolve('src/stress/tokens.json');

interface TestUser {
  privateKey: `0x${string}`;
  address: string;
  name: string;
  token: string;
}

function randomName(idx: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'bot_';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${s}_${idx.toString()}`;
}

async function getNonce(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/nonce`);
  if (!res.ok) throw new Error(`GET /auth/nonce: ${res.status.toString()}`);
  const data = (await res.json()) as { nonce: string };
  return data.nonce;
}

async function signupOne(idx: number): Promise<TestUser | null> {
  try {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const name = randomName(idx);
    const nonce = await getNonce();

    const msg = new SiweMessage({
      domain: SIWE_DOMAIN,
      address: account.address,
      statement: 'Blockfall stress test',
      uri: `http://${SIWE_DOMAIN}`,
      version: '1',
      chainId: SIWE_CHAIN_ID,
      nonce,
      issuedAt: new Date().toISOString(),
    });
    const message = msg.prepareMessage();
    const signature = await account.signMessage({ message });

    const res = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        signature,
        name,
        user_source: 'web',
        wallet_info: 'stress-test',
      }),
    });
    if (!res.ok) {
      console.error(`[${idx.toString()}] signup ${res.status.toString()}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { token: string };
    return {
      privateKey: pk,
      address: account.address.toLowerCase(),
      name,
      token: data.token,
    };
  } catch (err) {
    console.error(`[${idx.toString()}] error:`, err);
    return null;
  }
}

async function main(): Promise<void> {
  console.log(
    `Registering ${USER_COUNT.toString()} users at ${BASE_URL} (concurrency=${SIGNUP_CONCURRENCY.toString()})...`
  );
  const start = Date.now();
  const limit = pLimit(SIGNUP_CONCURRENCY);

  let done = 0;
  const tasks = Array.from({ length: USER_COUNT }, (_, i) =>
    limit(async () => {
      const user = await signupOne(i);
      done++;
      return user;
    })
  );

  const reporter = setInterval(() => {
    const pct = ((done / USER_COUNT) * 100).toFixed(1);
    console.log(`  ${done.toString()}/${USER_COUNT.toString()} (${pct}%)`);
  }, 2000);
  reporter.unref();

  const results = await Promise.all(tasks);
  clearInterval(reporter);

  const users = results.filter((r): r is TestUser => r !== null);
  await fs.writeFile(OUT_FILE, JSON.stringify(users, null, 2));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `Saved ${users.length.toString()}/${USER_COUNT.toString()} users to ${OUT_FILE} in ${elapsed}s`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
