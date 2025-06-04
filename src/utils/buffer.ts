/**
 * Utilidades para manipulación de buffers
 */
export class BufferUtils {
  /**
   * Lee un entero de 32 bits big-endian
   */
  static readUInt32BE(buffer: Buffer, offset: number = 0): number {
    return buffer.readUInt32BE(offset);
  }

  /**
   * Escribe un entero de 32 bits big-endian
   */
  static writeUInt32BE(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  }

  /**
   * Lee un entero de 16 bits big-endian
   */
  static readUInt16BE(buffer: Buffer, offset: number = 0): number {
    return buffer.readUInt16BE(offset);
  }

  /**
   * Escribe un entero de 16 bits big-endian
   */
  static writeUInt16BE(value: number): Buffer {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value, 0);
    return buffer;
  }

  /**
   * Convierte un bitfield a array de booleanos
   */
  static bitfieldToArray(bitfield: Buffer, totalPieces: number): boolean[] {
    const result: boolean[] = [];

    for (let i = 0; i < totalPieces; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);

      if (byteIndex < bitfield.length) {
        const byte = bitfield[byteIndex];
        result[i] = (byte & (1 << bitIndex)) !== 0;
      } else {
        result[i] = false;
      }
    }

    return result;
  }

  /**
   * Convierte un array de booleanos a bitfield
   */
  static arrayToBitfield(pieces: boolean[]): Buffer {
    const byteLength = Math.ceil(pieces.length / 8);
    const bitfield = Buffer.alloc(byteLength);

    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i]) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = 7 - (i % 8);
        bitfield[byteIndex] |= 1 << bitIndex;
      }
    }

    return bitfield;
  }

  /**
   * Convierte peers compactos (6 bytes por peer) a array de peers
   */
  static parsePeersCompact(peersBuffer: Buffer): Array<{ip: string, port: number}> {
    const peers: Array<{ip: string, port: number}> = [];

    // Cada peer ocupa 6 bytes: 4 para IP + 2 para puerto
    for (let i = 0; i < peersBuffer.length; i += 6) {
      if (i + 5 < peersBuffer.length) {
        const ip = `${peersBuffer[i]}.${peersBuffer[i + 1]}.${peersBuffer[i + 2]}.${peersBuffer[i + 3]}`;
        const port = peersBuffer.readUInt16BE(i + 4);
        peers.push({ ip, port });
      }
    }

    return peers;
  }
}