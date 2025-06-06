import { TorrentMetadata } from '../types/torrent_types';
import { CryptoUtils } from '../utils/crypto';

/**
 * Gestor de piezas para el torrent
 */
export class PieceManager {
    private metadata: TorrentMetadata;
    private pieces: PieceInfo[];
    private completedPieces: Set<number>;
    private currentPieceIndex: number;
    private pieceLength: number;

    constructor(metadata: TorrentMetadata) {
        this.metadata = metadata;
        // CORREGIDO: Usar el piece length del torrent, no calcular
        this.pieceLength = metadata.pieceLength; // Necesitamos añadir esto al metadata
        this.pieces = this.initializePieces();
        this.completedPieces = new Set();
        this.currentPieceIndex = 0;

        console.log(`🧩 Inicializado gestor de piezas: ${this.pieces.length} piezas de ${this.formatBytes(this.pieceLength)} cada una`);
    }

    /**
     * Inicializa la información de todas las piezas
     */
    private initializePieces(): PieceInfo[] {
        const pieces: PieceInfo[] = [];

        for (let i = 0; i < this.metadata.pieceCount; i++) {
            // CORREGIDO: Usar el piece length real del torrent
            const isLastPiece = i === this.metadata.pieceCount - 1;
            const size = isLastPiece
                ? this.metadata.totalLength - (i * this.pieceLength)
                : this.pieceLength;

            pieces.push({
                index: i,
                size,
                hash: this.metadata.pieceHashes[i],
                data: Buffer.alloc(size),
                blocks: new Map<number, Buffer>(),
                totalBlocks: Math.ceil(size / 16384),
                receivedBlocks: 0,
                requested: false,
                completed: false,
            });
        }

        return pieces;
    }

    // Añadir a la clase PieceManager
    getRarestPiece(peerBitfields: Map<string, boolean[]>): PieceInfo | null {
        // Contar cuántos peers tienen cada pieza
        const pieceCounts = new Map<number, number>();

        // Inicializar contadores para todas las piezas
        for (let i = 0; i < this.pieces.length; i++) {
            if (!this.pieces[i].completed && !this.pieces[i].requested) {
                pieceCounts.set(i, 0);
            }
        }

        // Contar cuántos peers tienen cada pieza
        for (const [_, bitfield] of peerBitfields.entries()) {
            for (const [index, hasPiece] of bitfield.entries()) {
                if (hasPiece && pieceCounts.has(index)) {
                    pieceCounts.set(index, pieceCounts.get(index)! + 1);
                }
            }
        }

        // Encontrar la pieza más rara (la que menos peers tienen)
        let rarestPieceIndex = -1;
        let minCount = Infinity;

        for (const [index, count] of pieceCounts.entries()) {
            if (count > 0 && count < minCount) {
                minCount = count;
                rarestPieceIndex = index;
            }
        }

        if (rarestPieceIndex !== -1) {
            const piece = this.pieces[rarestPieceIndex];
            piece.requested = true;
            return piece;
        }

        // Si no encontramos ninguna pieza rara, volver al método secuencial
        return this.getNextPieceToDownload();
    }

    /**
     * Obtiene la siguiente pieza a descargar (descarga secuencial)
     */
    getNextPieceToDownload(): PieceInfo | null {
        // CORREGIDO: Asegurar descarga estrictamente secuencial desde 0
        const nextPiece = this.pieces[this.currentPieceIndex];

        if (nextPiece && !nextPiece.completed && !nextPiece.requested) {
            nextPiece.requested = true;
            console.log(`🎯 Seleccionada pieza ${this.currentPieceIndex} para descarga (${this.formatBytes(nextPiece.size)})`);
            return nextPiece;
        }

        return null; // No hay siguiente pieza o ya está en proceso
    }

    /**
     * Añade un bloque a una pieza específica
     */
    addBlockToPiece(pieceIndex: number, offset: number, blockData: Buffer): boolean {
        const piece = this.pieces[pieceIndex];
        if (!piece) {
            console.error(`❌ Pieza ${pieceIndex} no existe`);
            return false;
        }

        if (piece.completed) {
            console.log(`⚠️ Pieza ${pieceIndex} ya está completada, ignorando bloque`);
            return true;
        }

        // Verificar que el offset es válido
        if (offset + blockData.length > piece.size) {
            console.error(`❌ Bloque fuera de rango para pieza ${pieceIndex}: offset=${offset}, size=${blockData.length}, pieceSize=${piece.size}`);
            return false;
        }

        // Añadir bloque si no lo tenemos ya
        if (!piece.blocks.has(offset)) {
            piece.blocks.set(offset, blockData);
            piece.receivedBlocks++;

            console.log(`📦 Bloque añadido a pieza ${pieceIndex}: offset=${offset}, size=${blockData.length} (${piece.receivedBlocks}/${piece.totalBlocks})`);
        }

        // Verificar si la pieza está completa
        if (piece.receivedBlocks >= piece.totalBlocks) {
            return this.assemblePiece(pieceIndex);
        }

        return false; // Pieza aún no está completa
    }

    /**
     * Ensambla todos los bloques de una pieza y verifica su hash
     */
    private assemblePiece(pieceIndex: number): boolean {
        const piece = this.pieces[pieceIndex];

        console.log(`🔧 Ensamblando pieza ${pieceIndex}...`);

        // Ordenar bloques por offset y ensamblar
        const sortedOffsets = Array.from(piece.blocks.keys()).sort((a, b) => a - b);

        let assembledData = Buffer.alloc(0);
        let expectedOffset = 0;

        for (const offset of sortedOffsets) {
            if (offset !== expectedOffset) {
                console.error(`❌ Falta bloque en offset ${expectedOffset} de pieza ${pieceIndex}`);
                return false;
            }

            const blockData = piece.blocks.get(offset)!;
            assembledData = Buffer.concat([assembledData, blockData]);
            expectedOffset += blockData.length;
        }

        // Verificar que tenemos todos los datos
        if (assembledData.length !== piece.size) {
            console.error(`❌ Tamaño incorrecto para pieza ${pieceIndex}: esperado=${piece.size}, recibido=${assembledData.length}`);
            return false;
        }

        // Verificar hash
        if (!CryptoUtils.verifyHash(assembledData, piece.hash)) {
            console.error(`❌ Hash inválido para pieza ${pieceIndex}`);
            piece.requested = false; // Permitir reintento
            piece.blocks.clear(); // Limpiar bloques corruptos
            piece.receivedBlocks = 0;
            return false;
        }

        // Marcar como completada
        piece.data = assembledData;
        piece.completed = true;
        this.completedPieces.add(pieceIndex);

        // Actualizar índice de pieza actual para descarga secuencial
        if (pieceIndex === this.currentPieceIndex) {
            this.currentPieceIndex++;
        }

        console.log(`✅ Pieza ${pieceIndex} completada y verificada (${this.getProgress()}%)`);
        return true;
    }

    /**
     * Verifica si una pieza está completa y válida
     */
    isPieceComplete(pieceIndex: number): boolean {
        return this.completedPieces.has(pieceIndex);
    }

    /**
     * Obtiene datos de una pieza específica
     */
    getPieceData(pieceIndex: number): Buffer | null {
        const piece = this.pieces[pieceIndex];
        return piece && piece.completed ? piece.data : null;
    }

    /**
     * Obtiene información de una pieza específica
     */
    getPieceInfo(pieceIndex: number): PieceInfo | null {
        return this.pieces[pieceIndex] || null;
    }

    /**
     * Obtiene el progreso de descarga
     */
    getProgress(): string {
        const completed = this.completedPieces.size;
        const total = this.pieces.length;
        const percentage = ((completed / total) * 100).toFixed(1);
        return percentage;
    }

    /**
     * Verifica si la descarga está completa
     */
    isDownloadComplete(): boolean {
        return this.completedPieces.size === this.pieces.length;
    }

    /**
     * Obtiene estadísticas de descarga
     */
    getStats(): {
        completed: number;
        total: number;
        percentage: number;
        bytesDownloaded: number;
        bytesTotal: number;
    } {
        const completed = this.completedPieces.size;
        const total = this.pieces.length;
        const percentage = (completed / total) * 100;

        const bytesDownloaded = Array.from(this.completedPieces)
            .reduce((sum, index) => sum + this.pieces[index].size, 0);

        return {
            completed,
            total,
            percentage,
            bytesDownloaded,
            bytesTotal: this.metadata.totalLength,
        };
    }

    /**
     * Resetea el estado de request de una pieza (para reintentos)
     */
    resetPieceRequest(pieceIndex: number): void {
        const piece = this.pieces[pieceIndex];
        if (piece && !piece.completed) {
            piece.requested = false;
            piece.blocks.clear();
            piece.receivedBlocks = 0;
            console.log(`🔄 Reset pieza ${pieceIndex} para reintento`);
        }
    }

    /**
     * Obtiene todas las piezas completadas ordenadas
     */
    getCompletedPiecesInOrder(): Buffer[] {
        const result: Buffer[] = [];

        for (let i = 0; i < this.pieces.length; i++) {
            if (this.completedPieces.has(i)) {
                result.push(this.pieces[i].data);
            } else {
                break; // Para descarga secuencial, paramos en la primera pieza faltante
            }
        }

        return result;
    }

    /**
     * Formatea bytes a unidades legibles
     */
    private formatBytes(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }
}

/**
 * Información de una pieza individual
 */
interface PieceInfo {
    index: number;
    size: number;
    hash: Buffer;
    data: Buffer;
    blocks: Map<number, Buffer>; // offset -> bloque
    totalBlocks: number;
    receivedBlocks: number;
    requested: boolean;
    completed: boolean;
}