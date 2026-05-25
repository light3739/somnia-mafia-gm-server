export interface Groth16Proof {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
  input: readonly bigint[];
}

/**
 * Parse the string returned by snarkjs `exportSolidityCallData` into typed
 * bigint arrays ready for Solidity ABI-encoding.
 *
 * snarkjs format (4 comma-separated JSON arrays):
 *   ["0x...","0x..."],[["0x...","0x..."],["0x...","0x..."]],["0x...","0x..."],["0x...",...,"0x..."]
 *
 * Wrapping in `[...]` makes it valid JSON we can parse in one shot.
 */
export function parseGroth16CallData(callData: string): Groth16Proof {
  const arr = JSON.parse(`[${callData}]`) as string[][] & any[];
  const bi = (x: string) => BigInt(x);
  const a = arr[0] as string[];
  const b = arr[1] as string[][];
  const c = arr[2] as string[];
  const input = arr[3] as string[];
  return {
    a: [bi(a[0]), bi(a[1])],
    b: [[bi(b[0][0]), bi(b[0][1])], [bi(b[1][0]), bi(b[1][1])]],
    c: [bi(c[0]), bi(c[1])],
    input: input.map(bi),
  };
}
