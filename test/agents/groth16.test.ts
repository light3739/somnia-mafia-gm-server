import { describe, it, expect } from "vitest";
import { parseGroth16CallData } from "../../src/agents/groth16.js";

describe("parseGroth16CallData", () => {
  it("parses snarkjs exportSolidityCallData into a/b/c/input bigints", () => {
    const cd = '["0x1","0x2"],[["0x3","0x4"],["0x5","0x6"]],["0x7","0x8"],["0x9","0xa","0xb","0xc","0xd","0xe"]';
    const r = parseGroth16CallData(cd);
    expect(r.a).toEqual([1n, 2n]);
    expect(r.b).toEqual([[3n, 4n], [5n, 6n]]);
    expect(r.c).toEqual([7n, 8n]);
    expect(r.input).toEqual([9n, 10n, 11n, 12n, 13n, 14n]);
  });
  it("handles decimal strings too", () => {
    const cd = '["1","2"],[["3","4"],["5","6"]],["7","8"],["9","10","11","12","13","14"]';
    expect(parseGroth16CallData(cd).input).toEqual([9n,10n,11n,12n,13n,14n]);
  });
});
