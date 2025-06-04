import * as fs from 'fs';
import * as path from 'path';
import { BencodeParser, BencodeDict } from '../parsers/bencode';
import { TorrentFile, TorrentInfo, TorrentMetadata } from '../types/torrent';
import { CryptoUtils } from '../utils/crypto';

/**
 * Clase principal para manejar archivos torrent
 */
export class TorrentParser {
    private torrentData: TorrentFile;
    private metadata: TorrentMetadata;
    private rawInfoDict: Buffer;

    constructor(torrentPath: string) {
        console.log(`📁 Cargando archivo torrent: ${torrentPath}`);

        // Leer y parsear el archivo .torrent
        const torrentBuffer = fs.readFileSync(torrentPath);
        const decoded = BencodeParser.decode(torrentBuffer) as BencodeDict;

        // Debug: mostrar las claves del torrent
        console.log('🔍 Claves encontradas en el torrent:', Object.keys(decoded));

        // Debug: mostrar valores de campos importantes
        this.debugTorrentData(decoded);

        this.rawInfoDict = this.extractRawInfoDict(torrentBuffer);
        this.torrentData = this.validateTorrentData(decoded);
        this.metadata = this.extractMetadata();

        console.log(`✅ Torrent cargado: ${this.metadata.fileName}`);
        console.log(`📊 Piezas: ${this.metadata.pieceCount}, Tamaño: ${this.formatBytes(this.metadata.totalLength)}`);
    }

    /**
     * Debug: muestra información del torrent decodificado
     */
    private debugTorrentData(decoded: BencodeDict): void {
        console.log('\n🔍 DEBUG - Contenido del torrent:');

        // Verificar announce
        if (decoded.announce) {
            const announceType = Buffer.isBuffer(decoded.announce) ? 'Buffer' : typeof decoded.announce;
            const announceValue = Buffer.isBuffer(decoded.announce)
                ? decoded.announce.toString()
                : decoded.announce;
            console.log(`  announce (${announceType}):`, announceValue);
        } else {
            console.log('  announce: NO ENCONTRADO');
        }

        // Verificar announce-list
        if (decoded['announce-list']) {
            console.log('  announce-list encontrado:', Array.isArray(decoded['announce-list']));
            if (Array.isArray(decoded['announce-list'])) {
                console.log('  announce-list entradas:', decoded['announce-list'].length);
            }
        }

        // Verificar info
        if (decoded.info) {
            console.log('  info encontrado:', typeof decoded.info);
            if (typeof decoded.info === 'object') {
                const info = decoded.info as BencodeDict;
                console.log('  info claves:', Object.keys(info));

                if (info.name) {
                    const nameValue = Buffer.isBuffer(info.name) ? info.name.toString() : info.name;
                    console.log('  info.name:', nameValue);
                }
            }
        } else {
            console.log('  info: NO ENCONTRADO');
        }
        console.log('');
    }

    /**
     * Extrae el diccionario info raw para calcular el hash
     */
    private extractRawInfoDict(torrentBuffer: Buffer): Buffer {
        try {
            // Buscar el patrón "4:info" en el buffer
            const infoPattern = Buffer.from('4:infod');
            let infoStart = -1;

            // Buscar el patrón
            for (let i = 0; i <= torrentBuffer.length - infoPattern.length; i++) {
                if (torrentBuffer.slice(i, i + 6).equals(Buffer.from('4:info'))) {
                    infoStart = i + 6; // Posición después de "4:info"
                    break;
                }
            }

            if (infoStart === -1) {
                throw new Error('No se encontró el diccionario info en el torrent');
            }

            // Parsear desde la posición del diccionario info para obtener su contenido completo
            const parser = new BencodeParser(torrentBuffer.slice(infoStart));
            const infoValue = parser['parseValue']();

            // Recodificar para obtener el buffer exacto
            return BencodeParser.encode(infoValue);

        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error extrayendo diccionario info: ${error.message}`);
            }
            throw new Error('Error desconocido extrayendo diccionario info');
        }
    }

    /**
     * Valida y convierte los datos del torrent con mejor manejo de tipos
     */
    private validateTorrentData(decoded: BencodeDict): TorrentFile {
        // Función helper para convertir Buffer a string
        const bufferToString = (value: any): string | undefined => {
            if (typeof value === 'string') return value;
            if (Buffer.isBuffer(value)) return value.toString();
            return undefined;
        };

        // Buscar announce en diferentes formas
        let announce: string | undefined;

        // Primero intentar con el campo announce directo
        announce = bufferToString(decoded.announce);

        // Si no se encuentra, buscar en announce-list
        if (!announce && decoded['announce-list']) {
            const announceList = decoded['announce-list'] as any[][];
            if (Array.isArray(announceList) && announceList.length > 0) {
                const firstTier = announceList[0];
                if (Array.isArray(firstTier) && firstTier.length > 0) {
                    announce = bufferToString(firstTier[0]);
                }
            }
        }

        if (!announce) {
            throw new Error('No se encontró campo "announce" válido. Verifique que el archivo .torrent sea válido.');
        }

        // Validar campo info
        if (!decoded.info || typeof decoded.info !== 'object') {
            throw new Error('Campo "info" faltante o inválido');
        }

        const info = decoded.info as BencodeDict;

        // Validar campos del info con mejor manejo de tipos
        const name = bufferToString(info.name);
        if (!name) {
            throw new Error('Campo "info.name" faltante o inválido');
        }

        if (!info['piece length'] || typeof info['piece length'] !== 'number') {
            throw new Error('Campo "info.piece length" faltante o inválido');
        }

        if (!info.pieces || !Buffer.isBuffer(info.pieces)) {
            throw new Error('Campo "info.pieces" faltante o inválido');
        }

        // Verificar que el número de hashes sea válido
        if (info.pieces.length % 20 !== 0) {
            throw new Error('Campo "info.pieces" tiene longitud inválida (debe ser múltiplo de 20)');
        }

        // Procesar announce-list si existe
        let announceListProcessed: string[][] | undefined;
        if (decoded['announce-list'] && Array.isArray(decoded['announce-list'])) {
            announceListProcessed = (decoded['announce-list'] as any[][]).map(tier =>
                tier.map(url => bufferToString(url)).filter(url => url !== undefined) as string[]
            ).filter(tier => tier.length > 0);
        }

        return {
            announce,
            'announce-list': announceListProcessed,
            info: {
                name,
                'piece length': info['piece length'] as number,
                pieces: info.pieces as Buffer,
                length: info.length as number | undefined,
                files: info.files as any[] | undefined,
                private: info.private as number | undefined,
            },
            'creation date': decoded['creation date'] as number | undefined,
            comment: bufferToString(decoded.comment),
            'created by': bufferToString(decoded['created by']),
        };
    }

    /**
     * Extrae metadatos procesados del torrent
     */
    private extractMetadata(): TorrentMetadata {
        // Calcular info hash usando el diccionario info raw
        const infoHash = CryptoUtils.calculateInfoHash(this.rawInfoDict);

        // Procesar hashes de piezas
        const pieceHashes: Buffer[] = [];
        const piecesBuffer = this.torrentData.info.pieces;

        for (let i = 0; i < piecesBuffer.length; i += 20) {
            pieceHashes.push(piecesBuffer.slice(i, i + 20));
        }

        // CORREGIDO: Usar el piece length del torrent
        const pieceLength = this.torrentData.info['piece length'];

        // Calcular tamaño total
        let totalLength: number;
        if (this.torrentData.info.length) {
            totalLength = this.torrentData.info.length;
        } else if (this.torrentData.info.files) {
            totalLength = this.torrentData.info.files.reduce(
                (sum, file) => sum + file.length, 0
            );
        } else {
            throw new Error('No se pudo determinar el tamaño total del torrent');
        }

        // Procesar lista de trackers
        const announceList: string[] = [this.torrentData.announce];
        if (this.torrentData['announce-list']) {
            for (const tier of this.torrentData['announce-list']) {
                for (const tracker of tier) {
                    if (!announceList.includes(tracker)) {
                        announceList.push(tracker);
                    }
                }
            }
        }

        return {
            infoHash,
            pieceHashes,
            totalLength,
            pieceCount: pieceHashes.length,
            pieceLength, // AÑADIR ESTA LÍNEA
            fileName: this.torrentData.info.name,
            announceList,
        };
    }

    /**
     * Getters para acceder a los datos
     */
    getMetadata(): TorrentMetadata {
        return this.metadata;
    }

    getTorrentData(): TorrentFile {
        return this.torrentData;
    }

    /**
     * Formatea bytes a unidades legibles
     */
    private formatBytes(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }

    /**
     * Información resumida del torrent
     */
    getSummary(): string {
        const meta = this.metadata;
        return [
            `Nombre: ${meta.fileName}`,
            `Tamaño: ${this.formatBytes(meta.totalLength)}`,
            `Piezas: ${meta.pieceCount}`,
            `Tamaño por pieza: ${this.formatBytes(meta.pieceLength)}`, // CORREGIDO
            `Trackers: ${meta.announceList.length}`,
            `Info Hash: ${meta.infoHash.toString('hex')}`,
        ].join('\n');
    }
}