import * as fs from 'fs';
import * as path from 'path';
import { TorrentMetadata } from '../types/torrent_types';

/**
 * Gestor de archivos para escribir datos descargados
 */
export class FileManager {
  private metadata: TorrentMetadata;
  private outputPath: string;
  private fileHandle: fs.promises.FileHandle | null = null;
  private bytesWritten: number = 0;

  constructor(metadata: TorrentMetadata, outputDir: string = './downloads') {
    this.metadata = metadata;
    this.outputPath = path.join(outputDir, metadata.fileName);
    
    // Crear directorio de salida si no existe
    this.ensureOutputDirectory();
    
    console.log(`📁 Gestor de archivos inicializado: ${this.outputPath}`);
  }

  /**
   * Asegura que el directorio de salida existe
   */
  private ensureOutputDirectory(): void {
    const dir = path.dirname(this.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📂 Directorio creado: ${dir}`);
    }
  }

  /**
   * Inicializa el archivo para escritura
   */
  async initializeFile(): Promise<void> {
    try {
      // Crear archivo con el tamaño total (sparse file)
      this.fileHandle = await fs.promises.open(this.outputPath, 'w');
      await this.fileHandle.truncate(this.metadata.totalLength);
      
      console.log(`📄 Archivo inicializado: ${this.outputPath} (${this.formatBytes(this.metadata.totalLength)})`);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error inicializando archivo: ${error.message}`);
        }
    }
  }

  /**
   * Escribe una pieza en la posición correcta del archivo
   */
  async writePiece(pieceIndex: number, data: Buffer): Promise<void> {
    if (!this.fileHandle) {
      throw new Error('Archivo no inicializado');
    }

    try {
      // Calcular posición en el archivo
      const position = pieceIndex * this.calculatePieceSize(pieceIndex);
      
      // Escribir datos en la posición específica
      await this.fileHandle.write(data, 0, data.length, position);
      this.bytesWritten += data.length;
      
      const progress = ((this.bytesWritten / this.metadata.totalLength) * 100).toFixed(1);
      console.log(`💾 Pieza ${pieceIndex} escrita (${progress}% completado)`);
      
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error escribiendo pieza ${pieceIndex}: ${error.message}`);
        }
    }
  }

  /**
   * Escribe múltiples piezas secuencialmente
   */
  async writePiecesSequential(pieces: Buffer[]): Promise<void> {
    if (!this.fileHandle) {
      throw new Error('Archivo no inicializado');
    }

    try {
      let position = 0;
      
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        await this.fileHandle.write(piece, 0, piece.length, position);
        position += piece.length;
        this.bytesWritten += piece.length;
        
        const progress = ((this.bytesWritten / this.metadata.totalLength) * 100).toFixed(1);
        console.log(`💾 Pieza ${i} escrita secuencialmente (${progress}% completado)`);
      }
      
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error en escritura secuencial: ${error.message}`);
        }
    }
  }

  /**
   * Verifica la integridad del archivo completo
   */
  async verifyFile(): Promise<boolean> {
    if (!this.fileHandle) {
      throw new Error('Archivo no inicializado');
    }

    try {
      console.log('🔍 Verificando integridad del archivo...');
      
      const buffer = Buffer.alloc(this.metadata.totalLength);
      await this.fileHandle.read(buffer, 0, this.metadata.totalLength, 0);
      
      // Verificar cada pieza
      let position = 0;
      for (let i = 0; i < this.metadata.pieceCount; i++) {
        const pieceSize = this.calculatePieceSize(i);
        const pieceData = buffer.slice(position, position + pieceSize);
        const expectedHash = this.metadata.pieceHashes[i];
        
        const crypto = require('crypto');
        const actualHash = crypto.createHash('sha1').update(pieceData).digest();
        
        if (!actualHash.equals(expectedHash)) {
          console.error(`❌ Verificación fallida en pieza ${i}`);
          return false;
        }
        
        position += pieceSize;
      }
      
      console.log('✅ Verificación de integridad completada exitosamente');
      return true;
      
    } catch (error) {
        if (error instanceof Error) {
            console.error(`❌ Error en verificación: ${error.message}`);
        }
      return false;
    }
  }

  /**
   * Calcula el tamaño de una pieza específica
   */
  private calculatePieceSize(pieceIndex: number): number {
    const standardPieceSize = Math.floor(this.metadata.totalLength / this.metadata.pieceCount);
    
    // La última pieza puede ser más pequeña
    if (pieceIndex === this.metadata.pieceCount - 1) {
      return this.metadata.totalLength - (pieceIndex * standardPieceSize);
    }
    
    return standardPieceSize;
  }

  /**
   * Obtiene estadísticas del archivo
   */
  getStats(): {
    bytesWritten: number;
    totalBytes: number;
    percentage: number;
    filePath: string;
  } {
    return {
      bytesWritten: this.bytesWritten,
      totalBytes: this.metadata.totalLength,
      percentage: (this.bytesWritten / this.metadata.totalLength) * 100,
      filePath: this.outputPath,
    };
  }

  /**
   * Finaliza y cierra el archivo
   */
  async finalize(): Promise<void> {
    if (this.fileHandle) {
      await this.fileHandle.sync(); // Asegurar que todos los datos estén escritos
      await this.fileHandle.close();
      this.fileHandle = null;
      
      console.log(`🎯 Archivo finalizado: ${this.outputPath}`);
    }
  }

  /**
   * Limpia recursos en caso de error
   */
  async cleanup(): Promise<void> {
    if (this.fileHandle) {
      try {
        await this.fileHandle.close();
      } catch (error) {
        if (error instanceof Error) {
            console.error(`Error cerrando archivo: ${error.message}`);
        }
      }
      this.fileHandle = null;
    }
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
   * Obtiene la ruta del archivo
   */
  getFilePath(): string {
    return this.outputPath;
  }

  /**
   * Verifica si el archivo existe
   */
  fileExists(): boolean {
    return fs.existsSync(this.outputPath);
  }
}