export class SignatureBuilder {
  private base: string;
  private params: string[] = [];
  private suffix: string = '';

  /**
   * Initialize a new signature builder.
   * Enforces the standard base format: action:chainId:roomId
   */
  constructor(action: string, chainId: number | string | undefined, roomId: number | string) {
    const cid = String(chainId || 50312);
    const rid = String(roomId);
    this.base = `${action}:${cid}:${rid}`;
  }

  /**
   * Add an Ethereum address as a parameter (automatically coerces to lowercase).
   */
  public withAddress(addr: string): this {
    this.params.push(String(addr).toLowerCase());
    return this;
  }

  /**
   * Add a generic string or number parameter (keeps original case, useful for hex pubkeys, salts, action types).
   */
  public withParam(param: string | number): this {
    this.params.push(String(param));
    return this;
  }

  /**
   * Add modern signature replay protection suffix.
   */
  public withModern(nonce: string, timestamp: number | string): this {
    this.suffix = `${nonce}:${String(timestamp)}`;
    return this;
  }

  /**
   * Finalize and construct the exact string representation exactly identical across both ends.
   */
  public build(): string {
    const chunks = [this.base];
    if (this.params.length > 0) chunks.push(this.params.join(':'));
    if (this.suffix) chunks.push(this.suffix);
    return chunks.join(':');
  }
}
