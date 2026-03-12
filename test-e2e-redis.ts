import Redis from 'ioredis';
import { buildPoseidon } from 'circomlibjs';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const GM_URL = process.env.GM_SERVER_URL || 'http://localhost:3001';

async function main() {
    console.log('🔗 Connecting to Redis:', REDIS_URL);
    const redis = new Redis(REDIS_URL);
    
    try {
        const poseidon = await buildPoseidon();
        const F = poseidon.F;
        const roomId = "999";

        // Mock players data matching circuit requirements (role: 1=Mafia, 0=Town)
        const mockPlayers = [
            { addr: "0x1111111111111111111111111111111111111111", role: 1, salt: "1".repeat(64) },
            { addr: "0x2222222222222222222222222222222222222222", role: 0, salt: "2".repeat(64) },
            { addr: "0x3333333333333333333333333333333333333333", role: 0, salt: "3".repeat(64) },
            { addr: "0x4444444444444444444444444444444444444444", role: 0, salt: "4".repeat(64) },
        ];

        console.log(`\n📝 Injecting mock secrets for Room #${roomId} into Redis...`);
        const secretsKey = `room:secrets:${roomId}`;
        
        for (const p of mockPlayers) {
            const saltBigInt = BigInt("0x" + p.salt);
            const hash = poseidon([BigInt(p.role), saltBigInt]);
            const commitment = F.toString(hash);
            
            const secret = {
                role: p.role,
                salt: p.salt,
                commitment: commitment
            };
            
            await redis.hset(secretsKey, p.addr.toLowerCase(), JSON.stringify(secret));
            console.log(`   ✅ Stored secret for ${p.addr.slice(0, 6)}...: role=${p.role}, commitment=${commitment.slice(0, 10)}...`);
        }
        
        // Set expiry
        await redis.expire(secretsKey, 3600);

        console.log('\n🚀 Triggering /end-game-zk via fetch...');
        const start = Date.now();
        const response = await fetch(`${GM_URL}/end-game-zk/${roomId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chainId: 50312 }) // Somnia Testnet
        });

        const duration = Date.now() - start;
        console.log(`⏱️ GM Server responded in ${duration}ms`);

        if (!response.ok) {
            const err = await response.json();
            throw new Error(`GM Server error: ${JSON.stringify(err)}`);
        }

        const { callData } = await response.json();
        console.log('\n✅ SUCCESS! Received callData from GM Server.');
        console.log('CallData length:', callData.length);
        console.log('Preview:', callData.slice(0, 150) + '...');

    } catch (error) {
        console.error('\n❌ E2E Test Failed:', error);
    } finally {
        redis.disconnect();
    }
}

main();
