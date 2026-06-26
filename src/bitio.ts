export class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; --i) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      if (++this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.nbits > 0) {
      this.bytes.push(this.cur << (8 - this.nbits));
      this.cur = 0;
      this.nbits = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

export class BitReader {
  private pos: number;
  private bitPos = 0;

  constructor(private readonly bytes: Uint8Array, startByte = 0) {
    this.pos = startByte;
  }

  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; ++i) {
      if (this.pos >= this.bytes.length) {
        throw new Error('truncated FineHash');
      }
      const bit = (this.bytes[this.pos]! >> (7 - this.bitPos)) & 1;
      v = (v << 1) | bit;
      if (++this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
    return v;
  }
}
