const snarkjs = require("snarkjs");
async function main() {
    try {
        const callData = await snarkjs.groth16.exportSolidityCallData({
            pi_a: ["1", "2", "3"],
            pi_b: [["4", "5"], ["6", "7"], ["8", "9"]],
            pi_c: ["10", "11", "12"],
            protocol: "groth16"
        }, ["13", "14"]);
        console.log("Raw output:");
        console.log(callData);
        console.log("---");
        const argv = callData.replace(/["\[\]\s]/g, "").split(",");
        console.log("Parsed (length " + argv.length + "):");
        console.log(argv);
    } catch(e) {
        console.error(e);
    }
}
main();
