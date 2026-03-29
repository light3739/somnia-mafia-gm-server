/**
 * routes/eciesRoutes.ts
 * POST /register-pubkey  — store player's ECIES public key
 * POST /submit-sra-key   — receive SRA decryption key, trigger role pre-cache
 * GET  /my-role/:roomId  — return ECIES-encrypted role
 * GET  /room-roles/:id   — all roles (after game end)
 * GET  /mafia-members/:id — mafia-only endpoint
 */
import { Router } from 'express';
import { type Address } from 'viem';
import { verifyAuthorizedSignature } from '../auth/verifySignature.js';
import { getRoom, getPlayers, getChainConfig, DIAMOND_ABI, FLAGS, GamePhase } from '../chain.js';
import { getRedis, rPersistPubkey, rPersistSraKey, rPersistRole } from '../redis.js';
import { eciesEncrypt } from '../ecies.js';
import { sraDecryptCard, roleFromCardValue } from '../crypto/sra.js';
import {
  eciesPubkeys, sraSKeys, resolvedRoles, roomPlayerOrder, getRoomMap,
} from '../stores/index.js';
import type { RateLimitRequestHandler } from 'express-rate-limit';

export function createEciesRoutes(
  actionLimiter: RateLimitRequestHandler,
  pollLimiter: RateLimitRequestHandler,
) {
  const router = Router();

  // ── Register ECIES Public Key ─────────────────────────────
  router.post('/register-pubkey', actionLimiter, async (req, res) => {
    const { roomId, playerAddress, pubkey, signature, signerAddress, nonce, timestamp, chainId } = req.body;
    if (!roomId || !playerAddress || !pubkey || !signature) {
      return res.status(400).json({ error: 'Missing req fields: roomId, playerAddress, pubkey, signature' });
    }
    if (!/^04[0-9a-fA-F]{128}$/.test(pubkey)) {
      return res.status(400).json({ error: 'Invalid pubkey: expected 65-byte uncompressed P-256 hex' });
    }

    const normalizedAddr = String(playerAddress).toLowerCase();
    const sigCheck = await verifyAuthorizedSignature({
      roomId: String(roomId), signature: signature as `0x${string}`,
      playerAddress: normalizedAddr, signerAddress, nonce, timestamp, chainId,
      buildLegacyMessage: () => `register-pubkey:${roomId}:${normalizedAddr}:${pubkey}`,
      buildModernMessage: (n, ts) => `register-pubkey:${roomId}:${normalizedAddr}:${pubkey}:${n}:${ts}`,
    });
    if (!sigCheck.ok) return res.status(sigCheck.status || 401).json({ error: sigCheck.error });

    try {
      const room: any = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
      const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
      if (phase !== GamePhase.REVEAL && phase !== GamePhase.ENDED && phase !== GamePhase.LOBBY) {
        return res.status(400).json({ error: `Cannot register pubkey outside REVEAL/LOBBY phase (current: ${phase})` });
      }
    } catch (e: any) {
      console.warn(`[register-pubkey] Phase check failed for room ${roomId}: ${e.message}`);
    }

    getRoomMap(eciesPubkeys, String(roomId)).set(normalizedAddr, pubkey);
    rPersistPubkey(getRedis(), String(roomId), normalizedAddr, pubkey);
    console.log(`[ecies] Room ${roomId}: pubkey registered for ${playerAddress}`);
    return res.json({ ok: true });
  });

  // ── Submit SRA Key ────────────────────────────────────────
  router.post('/submit-sra-key', actionLimiter, async (req, res) => {
    try {
      const { roomId, playerAddress, sraKey, signature, signerAddress, nonce, timestamp, chainId } = req.body;
      if (!roomId || !playerAddress || !sraKey || !signature) {
        return res.status(400).json({ error: 'Missing: roomId, playerAddress, sraKey, signature' });
      }
      try {
        if (BigInt(sraKey) <= 0n) throw new Error();
      } catch {
        return res.status(400).json({ error: 'sraKey must be a positive integer string' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId: String(roomId), signature: signature as `0x${string}`,
        playerAddress: String(playerAddress), signerAddress, nonce, timestamp, chainId,
        buildLegacyMessage: () => `submit-key:${roomId}:${sraKey}`,
        buildModernMessage: (n, ts) => `submit-key:${roomId}:${sraKey}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      // Phase check with retry
      let phaseMatch = false;
      let lastPhase = -1;
      for (let i = 0; i < 10; i++) {
        try {
          const room: any = await getRoom(BigInt(roomId), chainId ? Number(chainId) : undefined);
          lastPhase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);
          if (lastPhase === GamePhase.REVEAL || lastPhase === GamePhase.ENDED) { phaseMatch = true; break; }
        } catch (e: any) {
          console.warn(`[submit-sra-key] Phase check attempt ${i + 1} failed: ${e.message}`);
        }
        if (i < 9) await new Promise(r => setTimeout(r, 1000));
      }
      if (!phaseMatch) {
        const { diamond } = getChainConfig(chainId ? Number(chainId) : undefined);
        console.warn(`[submit-sra-key] Phase check failed room ${roomId} diamond ${diamond} phase ${lastPhase}`);
        return res.status(400).json({ error: `Cannot submit SRA key outside REVEAL phase (current: ${lastPhase})` });
      }

      const roomSraKeys = getRoomMap(sraSKeys, String(roomId));
      const normalizedPlayer = String(playerAddress).toLowerCase();
      roomSraKeys.set(normalizedPlayer, String(sraKey));
      rPersistSraKey(getRedis(), String(roomId), normalizedPlayer, String(sraKey));
      console.log(`[ecies] Room ${roomId}: SRA key received from ${playerAddress}`);

      // Eagerly pre-cache roles when all active keys are in
      try {
        const rid = BigInt(roomId);
        const chainIdNum = chainId ? Number(chainId) : undefined;
        const players = await getPlayers(rid, chainIdNum) as any[];
        const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
        const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
        const missingKeys = activeAddrs.filter((addr: string) => !roomSraKeys.has(addr));
        if (missingKeys.length === 0) {
          const { public: publicClient, diamond } = getChainConfig(chainIdNum);
          const deck = await publicClient.readContract({
            address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [rid],
          }) as string[];
          const roomKey = String(roomId);
          let stableOrder = roomPlayerOrder.get(roomKey);
          if (!stableOrder) {
            stableOrder = players.map((p: any) => p.wallet.toLowerCase());
            roomPlayerOrder.set(roomKey, stableOrder);
          }
          const allKeys = players.map((p: any) => roomSraKeys.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
          const roomRoles = getRoomMap(resolvedRoles, roomKey);
          stableOrder.forEach((addr, i) => {
            if (i < deck.length) {
              const role = roleFromCardValue(sraDecryptCard(deck[i], allKeys), Number(roomId));
              roomRoles.set(addr, role);
              rPersistRole(getRedis(), roomKey, addr, role);
            }
          });
          console.log(`[ecies] Room ${roomId}: all ${activeAddrs.length} SRA keys in — roles cached`);
        }
      } catch (cacheErr: any) {
        console.error(`[ecies] Room ${roomId}: role pre-cache error: ${cacheErr.message}`);
      }

      return res.json({ ok: true });
    } catch (err: any) {
      console.error('[submit-sra-key] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Get My Role ───────────────────────────────────────────
  router.get('/my-role/:roomId', pollLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { playerAddress, signature, signerAddress, nonce, timestamp, chainId } = req.query as Record<string, string>;
      if (!playerAddress || !signature) {
        return res.status(400).json({ error: 'Missing query params: playerAddress, signature' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId, signature: signature as `0x${string}`,
        playerAddress, signerAddress, nonce, timestamp: timestamp ? Number(timestamp) : undefined,
        chainId: chainId ? Number(chainId) : undefined,
        buildLegacyMessage: () => `my-role:${roomId}:${playerAddress.toLowerCase()}`,
        buildModernMessage: (n, ts) => `my-role:${roomId}:${playerAddress.toLowerCase()}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const normalizedPlayer = playerAddress.toLowerCase();
      const chainIdNum = chainId ? Number(chainId) : undefined;
      const rid = BigInt(roomId);

      const playerPubkey = eciesPubkeys.get(String(roomId))?.get(normalizedPlayer);
      if (!playerPubkey) {
        return res.status(404).json({ error: 'ECIES pubkey not registered. Call POST /register-pubkey first.' });
      }

      // Fast path: cached role
      const cachedRole = resolvedRoles.get(String(roomId))?.get(normalizedPlayer);
      if (cachedRole) {
        const encrypted = eciesEncrypt(playerPubkey, cachedRole);
        console.log(`[ecies] Room ${roomId}: role served from cache to ${playerAddress}`);
        return res.json({ encrypted });
      }

      const players = await getPlayers(rid, chainIdNum) as any[];
      const roomKey = String(roomId);
      let stableOrder = roomPlayerOrder.get(roomKey);
      if (!stableOrder) {
        stableOrder = players.map((p: any) => p.wallet.toLowerCase());
        roomPlayerOrder.set(roomKey, stableOrder);
      }
      const playerIndex = stableOrder.indexOf(normalizedPlayer);
      if (playerIndex === -1) return res.status(404).json({ error: 'Player not found in room order' });

      const keyMap = sraSKeys.get(String(roomId));
      const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
      const missingKeys = activeAddrs.filter((addr: string) => !keyMap?.has(addr));
      if (missingKeys.length > 0) {
        return res.status(202).json({
          pending: true, keysReceived: activeAddrs.length - missingKeys.length,
          keysExpected: activeAddrs.length, message: `Waiting for ${missingKeys.length} SRA keys`,
        });
      }

      const { public: publicClient, diamond } = getChainConfig(chainIdNum);
      const deck = await publicClient.readContract({
        address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [rid],
      }) as string[];

      if (!deck || deck.length === 0) return res.status(500).json({ error: 'Deck is empty on chain' });
      if (playerIndex >= deck.length) return res.status(500).json({ error: `Player index ${playerIndex} out of deck range` });

      const allKeys = players.map((p: any) => keyMap!.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
      const role = roleFromCardValue(sraDecryptCard(deck[playerIndex], allKeys), Number(roomId));
      const encrypted = eciesEncrypt(playerPubkey, role);

      console.log(`[ecies] Room ${roomId}: role served to ${playerAddress} (idx=${playerIndex}, role=${role})`);
      return res.json({ encrypted });
    } catch (err: any) {
      console.error('[my-role] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Get All Room Roles ────────────────────────────────────
  router.get('/room-roles/:roomId', pollLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { chainId, playerAddress, signature, nonce, timestamp } = req.query as Record<string, string>;
      const rid = BigInt(roomId);
      const chainIdNum = chainId ? Number(chainId) : undefined;

      const room: any = await getRoom(rid, chainIdNum);
      const phase = Array.isArray(room) ? Number(room[3]) : Number(room.phase);

      let isVerifiedMafia = false;
      if (playerAddress && signature && nonce && timestamp) {
        const sigCheck = await verifyAuthorizedSignature({
          roomId, signature: signature as `0x${string}`, playerAddress, nonce, timestamp: Number(timestamp),
          chainId: chainIdNum,
          buildLegacyMessage: () => `teammates:${roomId}`,
          buildModernMessage: (n, ts) => `teammates:${roomId}:${n}:${ts}`,
        });
        if (sigCheck.ok) {
          const cached = resolvedRoles.get(String(roomId));
          if (cached?.get(playerAddress.toLowerCase()) === 'MAFIA') isVerifiedMafia = true;
        }
      }

      const phaseDeadline = Number(Array.isArray(room) ? room[10] : (room.phaseDeadline || 0));
      const nowSec = Math.floor(Date.now() / 1000);
      const likelyEnded = phase === GamePhase.ENDED || (phaseDeadline > 0 && nowSec > phaseDeadline + 30);

      if (!likelyEnded && !isVerifiedMafia) {
        return res.status(403).json({ error: `Roles are only public after the game ends. Phase: ${phase}` });
      }

      const cached = resolvedRoles.get(String(roomId));
      if (cached && cached.size > 0) {
        const result: Record<string, string> = {};
        for (const [addr, role] of cached) {
          if (phase !== GamePhase.ENDED && isVerifiedMafia) {
            result[addr.toLowerCase()] = role === 'MAFIA' ? role : 'UNKNOWN';
          } else {
            result[addr.toLowerCase()] = role;
          }
        }
        return res.json({ roles: result });
      }

      const keyMap = sraSKeys.get(String(roomId));
      if (!keyMap || keyMap.size === 0) {
        return res.status(202).json({ pending: true, message: 'No SRA keys received yet.' });
      }

      const players = await getPlayers(rid, chainIdNum) as any[];
      const activePlayers = players.filter((p: any) => (Number(p.flags) & FLAGS.ACTIVE) !== 0);
      const activeAddrs = activePlayers.map((p: any) => p.wallet.toLowerCase());
      const missingKeys = activeAddrs.filter((addr: string) => !keyMap.has(addr));
      if (missingKeys.length > 0) {
        return res.status(202).json({ pending: true, keysReceived: keyMap.size, keysExpected: activeAddrs.length, message: `Missing ${missingKeys.length} keys` });
      }

      const { public: publicClient, diamond } = getChainConfig(chainIdNum);
      const deck = await publicClient.readContract({
        address: diamond, abi: DIAMOND_ABI, functionName: 'getDeck', args: [rid],
      }) as string[];

      const allKeys = players.map((p: any) => keyMap.get(p.wallet.toLowerCase())).filter(Boolean) as string[];
      const roomRoles = getRoomMap(resolvedRoles, String(roomId));
      players.forEach((p: any, i: number) => {
        if (i < deck.length) {
          const role = roleFromCardValue(sraDecryptCard(deck[i], allKeys), Number(roomId));
          roomRoles.set(p.wallet.toLowerCase(), role);
          rPersistRole(getRedis(), String(roomId), p.wallet.toLowerCase(), role);
        }
      });

      const result: Record<string, string> = {};
      for (const [addr, role] of roomRoles) result[addr.toLowerCase()] = role;
      return res.json({ roles: result });
    } catch (err: any) {
      console.error('[room-roles] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Mafia Members ─────────────────────────────────────────
  router.get('/mafia-members/:roomId', pollLimiter, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { playerAddress, signature, nonce, timestamp, chainId } = req.query as Record<string, string>;
      if (!playerAddress || !signature || !nonce || !timestamp) {
        return res.status(400).json({ error: 'Missing authentication parameters' });
      }

      const sigCheck = await verifyAuthorizedSignature({
        roomId, signature: signature as `0x${string}`, playerAddress, nonce, timestamp: Number(timestamp),
        chainId: chainId ? Number(chainId) : undefined,
        buildLegacyMessage: () => `mafia-members:${roomId}`,
        buildModernMessage: (n, ts) => `mafia-members:${roomId}:${n}:${ts}`,
      });
      if (!sigCheck.ok) return res.status(sigCheck.status).json({ error: sigCheck.error });

      const cachedRoles = resolvedRoles.get(String(roomId));
      if (!cachedRoles || cachedRoles.size === 0) {
        return res.status(202).json({ pending: true, message: 'Roles not yet resolved.' });
      }

      const callerRole = cachedRoles.get(playerAddress.toLowerCase());
      if (callerRole !== 'MAFIA') {
        return res.status(403).json({ error: 'Access denied: caller is not Mafia' });
      }

      const mafiaAddresses = [...cachedRoles.entries()]
        .filter(([, role]) => role === 'MAFIA')
        .map(([addr]) => addr.toLowerCase())
        .sort();

      return res.json({ mafia: mafiaAddresses });
    } catch (err: any) {
      console.error('[mafia-members] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}
