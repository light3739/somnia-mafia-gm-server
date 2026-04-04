import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import path from "path";
import { logger } from './utils/logger.js';

const WASM = path.join(process.cwd(), "zk/mafia_outcome.wasm");
const ZKEY = path.join(process.cwd(), "zk/mafia_outcome_final.zkey");

let poseidon: any;
let F: any;

async function initPoseidon() {
    if (!poseidon) {
        poseidon = await buildPoseidon();
        F = poseidon.F;
    }
}

export async function calculatePoseidon(inputs: any[]): Promise<string> {
    await initPoseidon();
    const hash = poseidon(inputs.map(i => BigInt(i)));
    return "0x" + F.toString(hash, 16).padStart(64, '0');
}


export async function calculatePublicStateHash(roleCommits: string[], isActives: string[]): Promise<string> {
    await initPoseidon();
    let leaves = [];
    for (let i = 0; i < 16; i++) {
        leaves.push(poseidon([BigInt(roleCommits[i]), BigInt(isActives[i])]));
    }
    
    let level1 = [];
    for(let i=0; i<8; i++) level1.push(poseidon([leaves[i*2], leaves[i*2+1]]));
    
    let level2 = [];
    for(let i=0; i<4; i++) level2.push(poseidon([level1[i*2], level1[i*2+1]]));
    
    let level3 = [];
    for(let i=0; i<2; i++) level3.push(poseidon([level2[i*2], level2[i*2+1]]));
    
    const root = poseidon([level3[0], level3[1]]);
    return F.toString(root, 10);
}

export async function generateEndGameProof(roomId: string, players: any[]) {
    const N = 16;
    const padded = players.slice(0, N);
    while (padded.length < N) {
        // Use consistent padding values that won't interfere with the circuit logic
        padded.push({ role: 0, salt: "0".repeat(64), commitment: "14744269619966411208579211824598458697587494354926760081771325075741142829156", isActive: 0 });
    }

    const mafiaCount = padded.filter(p => p.isActive === 1 && p.role === 1).length;
    const townCount  = padded.filter(p => p.isActive === 1 && p.role === 0).length;

    logger.info(`[ZK] Starting proof generation for room ${roomId}...`);
    const start = Date.now();

    const { proof, publicSignals } = await snarkjs.groth16.fullProve({
        roomId: BigInt(roomId).toString(),
        mafiaCount: mafiaCount.toString(),
        townCount: townCount.toString(),
        publicStateHash: await calculatePublicStateHash(
            padded.map(p => BigInt(p.commitment).toString()),
            padded.map(p => p.isActive.toString())
        ),
        roleCommits: padded.map(p => BigInt(p.commitment).toString()),
        isActive:    padded.map(p => p.isActive.toString()),
        roles:       padded.map(p => p.role.toString()),      // приватные
        salts:       padded.map(p =>                           // приватные
            BigInt("0x" + p.salt.replace("0x","")).toString()
        ),
    }, WASM, ZKEY);

    const duration = Date.now() - start;
    logger.info(`[ZK] Proof generated successfully for room ${roomId} in ${duration}ms`);

    return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}
