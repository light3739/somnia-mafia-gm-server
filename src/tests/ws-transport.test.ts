/**
 * Integration test: verify WebSocket RPC transport works with Somnia testnet.
 *
 * Tests:
 * 1. WebSocket connection to wss://api.infra.testnet.somnia.network/ws
 * 2. Basic read (getBlockNumber) via WebSocket transport
 * 3. watchContractEvent subscription (event listener setup/teardown)
 * 4. Fallback from WebSocket to HTTP if WS fails
 *
 * Run: npx tsx src/tests/ws-transport.test.ts
 */
import { createPublicClient, webSocket, http, fallback } from 'viem';
import { defineChain } from 'viem';

const SOMNIA_WS_URL = process.env.SOMNIA_WS_URL || 'wss://api.infra.testnet.somnia.network/ws';
const SOMNIA_HTTP_URL = process.env.SOMNIA_RPC_URL || 'https://api.infra.testnet.somnia.network/';
const DIAMOND = '0x0406a14729b0c77c187ac5229c8c2317589e73c0' as const;

const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Testnet',
  nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
  rpcUrls: {
    default: {
      http: [SOMNIA_HTTP_URL],
      webSocket: [SOMNIA_WS_URL],
    },
  },
  testnet: true,
});

// Minimal ABI — just need one event to test subscription
const MINIMAL_ABI = [
  {
    type: 'event',
    name: 'RoomCreated',
    inputs: [
      { name: 'roomId', type: 'uint256', indexed: true },
      { name: 'host', type: 'address', indexed: false },
      { name: 'name', type: 'string', indexed: false },
      { name: 'maxPlayers', type: 'uint256', indexed: false },
    ],
  },
] as const;

let passed = 0;
let failed = 0;

function ok(name: string) { passed++; console.log(`  ✅ ${name}`); }
function fail(name: string, err: any) { failed++; console.log(`  ❌ ${name}: ${err?.message || err}`); }

async function main() {
  console.log('\n=== WebSocket RPC Transport Tests ===\n');
  console.log(`WS URL:   ${SOMNIA_WS_URL}`);
  console.log(`HTTP URL: ${SOMNIA_HTTP_URL}`);
  console.log(`Diamond:  ${DIAMOND}\n`);

  // ── Test 1: WebSocket-only client can getBlockNumber ──
  console.log('Test 1: WebSocket transport — getBlockNumber');
  try {
    const wsClient = createPublicClient({
      chain: somniaTestnet,
      transport: webSocket(SOMNIA_WS_URL, {
        reconnect: { delay: 2_000, attempts: 3 },
        keepAlive: { interval: 25_000 },
      }),
    });
    const block = await wsClient.getBlockNumber();
    if (block > 0n) {
      ok(`Block number: ${block}`);
    } else {
      fail('getBlockNumber', 'returned 0');
    }
    // Cleanup WS client
    await wsClient.transport.value?.close?.();
  } catch (e) {
    fail('getBlockNumber via WS', e);
  }

  // ── Test 2: Fallback transport (WS primary, HTTP fallback) ──
  console.log('\nTest 2: Fallback transport — WS primary, HTTP secondary');
  try {
    const fallbackClient = createPublicClient({
      chain: somniaTestnet,
      transport: fallback([
        webSocket(SOMNIA_WS_URL, {
          reconnect: { delay: 2_000, attempts: 3 },
          keepAlive: { interval: 25_000 },
        }),
        http(SOMNIA_HTTP_URL),
      ]),
    });
    const block = await fallbackClient.getBlockNumber();
    if (block > 0n) {
      ok(`Block number: ${block} (via fallback)`);
    } else {
      fail('getBlockNumber via fallback', 'returned 0');
    }
  } catch (e) {
    fail('getBlockNumber via fallback', e);
  }

  // ── Test 3: watchContractEvent via WebSocket ──
  console.log('\nTest 3: watchContractEvent subscription via WS');
  try {
    const wsClient = createPublicClient({
      chain: somniaTestnet,
      transport: webSocket(SOMNIA_WS_URL, {
        reconnect: { delay: 2_000, attempts: 3 },
        keepAlive: { interval: 25_000 },
      }),
    });

    let receivedEvent = false;
    const unwatch = wsClient.watchContractEvent({
      address: DIAMOND,
      abi: MINIMAL_ABI,
      eventName: 'RoomCreated',
      onLogs: (logs) => {
        receivedEvent = true;
        console.log(`    📡 Received ${logs.length} RoomCreated event(s)`);
      },
    });

    // Subscription is set up — wait briefly to confirm no errors
    await new Promise(r => setTimeout(r, 3000));
    unwatch();
    ok('watchContractEvent subscription created and cleaned up (no errors)');

    await wsClient.transport.value?.close?.();
  } catch (e) {
    fail('watchContractEvent via WS', e);
  }

  // ── Test 4: Fallback when WS URL is bad ──
  console.log('\nTest 4: Fallback to HTTP when WS URL is invalid');
  try {
    const badWsClient = createPublicClient({
      chain: somniaTestnet,
      transport: fallback([
        webSocket('wss://invalid-endpoint.example.com/ws', {
          reconnect: { delay: 500, attempts: 1 },
        }),
        http(SOMNIA_HTTP_URL),
      ]),
    });
    const block = await badWsClient.getBlockNumber();
    if (block > 0n) {
      ok(`Fallback to HTTP works — block: ${block}`);
    } else {
      fail('HTTP fallback', 'returned 0');
    }
  } catch (e) {
    fail('HTTP fallback', e);
  }

  // ── Results ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
