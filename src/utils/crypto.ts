import * as crypto from 'crypto';

/**
 * Utilidades criptográficas para el cliente BitTorrent
 */
export class CryptoUtils {
  /**
   * Calcula el hash SHA1 de un buffer
   */
  static sha1(data: Buffer): Buffer {
    return crypto.createHash('sha1').update(data).digest();
  }

  /**
   * Genera un peer ID aleatorio de 20 bytes
   * Formato: -TS0001-<12 bytes aleatorios>
   */
  static generatePeerId(): Buffer {
    const prefix = Buffer.from('-TS0001-'); // TS = TorrentSimple
    const random = crypto.randomBytes(12);
    return Buffer.concat([prefix, random]);
  }

  /**
   * Verifica si un hash coincide con los datos
   */
  static verifyHash(data: Buffer, expectedHash: Buffer): boolean {
    const actualHash = CryptoUtils.sha1(data);
    return actualHash.equals(expectedHash);
  }

  /**
   * Calcula el info hash de un diccionario info bencoded
   */
  static calculateInfoHash(infoDict: Buffer): Buffer {
    return CryptoUtils.sha1(infoDict);
  }
}