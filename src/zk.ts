// src/zk.ts — новый файл
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import path from "path";

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
    return F.toString(hash);
}

export async function generateEndGameProof(roomId: string, players: any[]) {
    const N = 16;
    const padded = [...players];
    while (padded.length < N) {
        // Use consistent padding values that won't interfere with the circuit logic
        padded.push({ role: 0, salt: "0".repeat(64), commitment: "0", isActive: 0 });
    }

    const mafiaCount = padded.filter(p => p.isActive === 1 && p.role === 1).length;
    const townCount  = padded.filter(p => p.isActive === 1 && p.role === 0).length;

    console.log(`[ZK] Starting proof generation for room ${roomId}...`);
    const start = Date.now();

    const { proof, publicSignals } = await snarkjs.groth16.fullProve({
        roomId: BigInt(roomId).toString(),
        mafiaCount: mafiaCount.toString(),
        townCount: townCount.toString(),
        roleCommits: padded.map(p => BigInt(p.commitment).toString()),
        isActive:    padded.map(p => p.isActive.toString()),
        roles:       padded.map(p => p.role.toString()),      // приватные
        salts:       padded.map(p =>                           // приватные
            BigInt("0x" + p.salt.replace("0x","")).toString()
        ),
    }, WASM, ZKEY);

    const duration = Date.now() - start;
    console.log(`[ZK] Proof generated successfully for room ${roomId} in ${duration}ms`);

    return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}
