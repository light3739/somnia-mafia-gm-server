import * as snarkjs from "snarkjs";
async function run() {
    const callData = await snarkjs.groth16.exportSolidityCallData({pi_a:['1','2','3'],pi_b:[['4','5'],['6','7'],['8','9']],pi_c:['10','11','12'],protocol:'groth16', curve:'bn128'}, ['13','14']);
    console.log(callData);
    const argv = callData.replace(/["\[\]\s]/g, '').split(',');
    console.log('---');
    console.log('argv len:', argv.length);
    console.log('argv:', argv);
}
run();
