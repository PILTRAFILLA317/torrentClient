/**
 * Parser para el formato Bencoding usado en archivos .torrent
 * Especificación: http://www.bittorrent.org/beps/bep_0003.html
 */

export type BencodeValue = string | number | Buffer | BencodeDict | BencodeValue[];
export type BencodeDict = { [key: string]: BencodeValue };

export class BencodeParser {
  private data: Buffer;
  private position: number;

  constructor(data: Buffer) {
    this.data = data;
    this.position = 0;
  }

  /**
   * Decodifica datos bencoded
   */
  static decode(data: Buffer): BencodeValue {
    const parser = new BencodeParser(data);
    return parser.parseValue();
  }

  /**
   * Codifica un valor a bencoding
   */
  static encode(value: BencodeValue): Buffer {
    if (typeof value === 'string') {
      return BencodeParser.encodeString(value);
    }
    if (typeof value === 'number') {
      return BencodeParser.encodeInteger(value);
    }
    if (Buffer.isBuffer(value)) {
      return BencodeParser.encodeBuffer(value);
    }
    if (Array.isArray(value)) {
      return BencodeParser.encodeList(value);
    }
    if (typeof value === 'object') {
      return BencodeParser.encodeDictionary(value as BencodeDict);
    }
    throw new Error(`Tipo no soportado: ${typeof value}`);
  }

  /**
   * Parsea el siguiente valor en la posición actual (método público)
   */
  parseValue(): BencodeValue {
    const char = String.fromCharCode(this.data[this.position]);

    if (char >= '0' && char <= '9') {
      return this.parseString();
    }
    if (char === 'i') {
      return this.parseInteger();
    }
    if (char === 'l') {
      return this.parseList();
    }
    if (char === 'd') {
      return this.parseDictionary();
    }

    throw new Error(
      `Carácter inesperado '${char}' en posición ${this.position}`
    );
  }

  /**
   * Parsea una cadena: <longitud>:<cadena>
   */
  private parseString(): Buffer {
    const colonIndex = this.data.indexOf(58, this.position); // 58 = ':'
    if (colonIndex === -1) {
      throw new Error('Formato de cadena inválido: falta ":"');
    }

    const lengthStr = this.data.slice(this.position, colonIndex).toString();
    const length = parseInt(lengthStr, 10);

    if (isNaN(length) || length < 0) {
      throw new Error(`Longitud de cadena inválida: ${lengthStr}`);
    }

    this.position = colonIndex + 1;
    const stringData = this.data.slice(this.position, this.position + length);
    this.position += length;

    return stringData;
  }

  /**
   * Parsea un entero: i<número>e
   */
  private parseInteger(): number {
    this.position++; // Saltar 'i'
    const endIndex = this.data.indexOf(101, this.position); // 101 = 'e'

    if (endIndex === -1) {
      throw new Error('Formato de entero inválido: falta "e"');
    }

    const numberStr = this.data.slice(this.position, endIndex).toString();
    this.position = endIndex + 1;

    const number = parseInt(numberStr, 10);
    if (isNaN(number)) {
      throw new Error(`Entero inválido: ${numberStr}`);
    }

    return number;
  }

  /**
   * Parsea una lista: l<elementos>e
   */
  private parseList(): BencodeValue[] {
    this.position++; // Saltar 'l'
    const list: BencodeValue[] = [];

    while (this.position < this.data.length && this.data[this.position] !== 101) {
      list.push(this.parseValue());
    }

    if (this.position >= this.data.length) {
      throw new Error('Formato de lista inválido: falta "e"');
    }

    this.position++; // Saltar 'e'
    return list;
  }

  /**
   * Parsea un diccionario: d<clave><valor>...e
   */
  private parseDictionary(): BencodeDict {
    this.position++; // Saltar 'd'
    const dict: BencodeDict = {};

    while (this.position < this.data.length && this.data[this.position] !== 101) {
      // Parsear clave (siempre es una cadena)
      const keyBuffer = this.parseString();
      const key = keyBuffer.toString();

      // Parsear valor
      const value = this.parseValue();
      dict[key] = value;
    }

    if (this.position >= this.data.length) {
      throw new Error('Formato de diccionario inválido: falta "e"');
    }

    this.position++; // Saltar 'e'
    return dict;
  }

  // Métodos estáticos para encoding
  private static encodeString(str: string): Buffer {
    const data = Buffer.from(str);
    return Buffer.concat([Buffer.from(`${data.length}:`), data]);
  }

  private static encodeBuffer(buf: Buffer): Buffer {
    return Buffer.concat([Buffer.from(`${buf.length}:`), buf]);
  }

  private static encodeInteger(num: number): Buffer {
    return Buffer.from(`i${num}e`);
  }

  private static encodeList(list: BencodeValue[]): Buffer {
    const encoded = list.map(item => BencodeParser.encode(item));
    return Buffer.concat([Buffer.from('l'), ...encoded, Buffer.from('e')]);
  }

  private static encodeDictionary(dict: BencodeDict): Buffer {
    const encoded: Buffer[] = [Buffer.from('d')];

    // Las claves deben estar ordenadas lexicográficamente
    const sortedKeys = Object.keys(dict).sort();

    for (const key of sortedKeys) {
      encoded.push(BencodeParser.encodeString(key));
      encoded.push(BencodeParser.encode(dict[key]));
    }

    encoded.push(Buffer.from('e'));
    return Buffer.concat(encoded);
  }
}