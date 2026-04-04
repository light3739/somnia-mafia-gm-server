import { createPublicClient, http } from 'viem';
import { defineChain } from 'viem';
import { DIAMOND_ABI } from './src/abi.ts';

const somniaTestnet = defineChain({
    id: 50312,
    name: 'Somnia Testnet',
    network: 'somnia-testnet',
    nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: ['https://dream-rpc.somnia.network'] } },
});

const client = createPublicClient({ chain: somniaTestnet, transport: http() });

async function main() {
    const proofRaw = {"winDetected":true,"result":"TOWN_WIN","formatted":{"a":["0x17c2b0edbcec4a4a631d022f7d6921ca032d460dd8a955ebf17841250392f5ba","0x15a0af693eff18ca5b6ddd2b7e51011f5ae2b151825490a112bb5d4bff1329a6"],"b":[["0x1c338096b576d4b55dbc01fd214f90b7aa3df84082fd0ee6f34ded921883e289","0x14486f6ec92a12ba55471840e314d0a7b8b8e9dfb6a4f5253b0440021f144e52"],["0x203f8e9716d10a4b409ac6c865d187febe9afe0180c75ec76bf50094a414b229","0x0872af22770d503efdf036debb266ef5a7e7a916c0705a66e2f81719d1b3fa8a"]],"c":["0x17092990dae22303427979beded056b934920cdc905e04843e1c6c4570cd4cd2","0x186af3016702ea0befc43f348d441747d165bae4c412d02efe90f15051dd1202"],"inputs":["0x0000000000000000000000000000000000000000000000000000000000000001","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000000000000000000000000000000000000000000040","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000000000000000000000000000000000000000000003"]}};
    const f = proofRaw.formatted;
    const args = [ 64n, f.a, f.b, f.c, f.inputs ];
    console.log(args)
    
}
main().catch(console.error);
