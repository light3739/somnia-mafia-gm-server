const { groth16 } = require("snarkjs");
const path = require("path");

async function main() {
    const WASM = path.join(process.cwd(), "zk/mafia_outcome.wasm");
    const ZKEY = path.join(process.cwd(), "zk/mafia_outcome_final.zkey");
    const N = 16;
    const padded = [];
    while (padded.length < N) padded.push({ role: 0, salt: "0x"+"0".repeat(64), commitment: "1", isActive: 0 });
    
    // just dummy
    const input = {
        roomId: "1",
        mafiaCount: "0",
        townCount: "0",
        roleCommits: padded.map(p => p.commitment),
        isActive:    padded.map(p => p.isActive.toString()),
        roles:       padded.map(p => p.role.toString()),
        salts:       padded.map(p => "0")
    };
    
    console.log("Generating proof...");
    const { proof, publicSignals } = await groth16.fullProve(input, WASM, ZKEY);
    const callData = await groth16.exportSolidityCallData(proof, publicSignals);
    console.log("solidityCallData:", callData);
    
    const argv = callData.replace(/["\[\]\s]/g, "").split(",");
    
    console.log("B from callData:");
    console.log(`[ [${argv[2]}, ${argv[3]}], [${argv[4]}, ${argv[5]}] ]`);
    
    console.log("\nPublic signals from snarkjs vs our parsing:");
    console.log("snarkjs output:", publicSignals);
    console.log("Parsed inputs:", argv.slice(8));
}
main().catch(console.error);
