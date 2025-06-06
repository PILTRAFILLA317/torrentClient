import * as fs from 'fs';
import * as path from 'path';
import { TorrentParser } from './core/torrent';
import { TrackerClient } from './network/tracker';
import { PeerClient } from './network/peer';
import { PieceManager } from './core/piece-manager';
import { FileManager } from './core/file-manager';
import { CryptoUtils } from './utils/crypto';
import { BufferUtils } from './utils/buffer';

/**
 * Cliente BitTorrent simple
 */
export class SimpleTorrentClient {
    private torrentParser: TorrentParser;
    private trackerClient: TrackerClient;
    private pieceManager: PieceManager;
    private fileManager: FileManager;
    private activePeers: PeerClient[] = [];
    private downloadComplete: boolean = false;
    private piecesInProgress: Set<number> = new Set();
    private pieceTimeouts: Map<number, NodeJS.Timeout> = new Map();

    constructor(torrentPath: string, outputDir: string = './downloads') {
        console.log('🚀 Iniciando Simple Torrent Client');

        // Validar archivo torrent
        if (!fs.existsSync(torrentPath)) {
            throw new Error(`Archivo torrent no encontrado: ${torrentPath}`);
        }

        // Inicializar componentes
        this.torrentParser = new TorrentParser(torrentPath);
        const metadata = this.torrentParser.getMetadata();

        this.trackerClient = new TrackerClient(metadata);
        this.pieceManager = new PieceManager(metadata);
        this.fileManager = new FileManager(metadata, outputDir);

        console.log('\n📋 Información del Torrent:');
        console.log(this.torrentParser.getSummary());
    }

    /**
     * Inicia el proceso de descarga
     */
    async startDownload(): Promise<void> {
        try {
            console.log('\n🔥 Iniciando descarga...');

            // Inicializar archivo de salida
            await this.fileManager.initializeFile();

            // Obtener peers del tracker
            const peers = await this.trackerClient.getPeers(
                this.torrentParser.getMetadata()
            );

            if (peers.length === 0) {
                throw new Error('No se encontraron peers disponibles');
            }

            console.log(`👥 Encontrados ${peers.length} peers disponibles`);


            // Conectar a peers (máximo 5 conexiones simultáneas)
            await this.connectToPeers(peers.slice(0, 30));

            // // Iniciar descarga secuencial
            await this.downloadSequentially();

            // // Finalizar descarga
            await this.finishDownload();

        } catch (error) {
            if (error instanceof Error) {

                console.error(`❌ Error durante la descarga: ${error.message}`);
            }
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Conecta a múltiples peers
     */
    private failedPeers: Set<string> = new Set();

    private async connectToPeers(peerList: Array<{ ip: string; port: number }>): Promise<void> {
        const metadata = this.torrentParser.getMetadata();
        const peerId = CryptoUtils.generatePeerId();

        console.log(`🔌 Intentando conectar a ${peerList.length} peers en paralelo...`);

        // Crear promesas para conectar a todos los peers simultáneamente
        const connectionPromises = peerList.map(async (peerInfo) => {
            const peerKey = `${peerInfo.ip}:${peerInfo.port}`;

            if (this.failedPeers.has(peerKey)) {
                return null; // Ignorar peers que ya fallaron
            }

            try {
                const peer = {
                    id: Buffer.alloc(20),
                    ip: peerInfo.ip,
                    port: peerInfo.port,
                    choked: true,
                    interested: false,
                    choking: true,
                    peerInterested: false,
                };

                const peerClient = new PeerClient(peer, metadata, peerId);
                this.setupPeerEvents(peerClient);

                // Establecer un timeout para la conexión
                const connectPromise = peerClient.connect();
                const timeoutPromise = new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error('Timeout')), 5000); // 5 segundos de timeout
                });

                await Promise.race([connectPromise, timeoutPromise]);
                return peerClient;

            } catch (error) {
                this.failedPeers.add(peerKey);
                return null;
            }
        });

        // Esperar a que todas las conexiones se intenten
        const results = await Promise.allSettled(connectionPromises);

        // Filtrar los peers conectados exitosamente
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value !== null) {
                this.activePeers.push(result.value);
            }
        });

        console.log(`✅ Conectado exitosamente a ${this.activePeers.length} peers de ${peerList.length}`);
    }

    /**
     * Configura eventos de un peer
     */
    private setupPeerEvents(peerClient: PeerClient): void {
        peerClient.on('connected', () => {
            console.log(`🎯 Peer conectado y listo: ${peerClient.getPeerInfo().ip}`);

            // Enviar mensajes de keep-alive cada 2 minutos
            setInterval(() => {
                if (peerClient.isConnected()) {
                    peerClient.sendKeepAlive();
                }
            }, 120000); // 2 minutos
        });

        peerClient.on('unchoked', () => {
            console.log(`🔓 Peer unchoked: ${peerClient.getPeerInfo().ip}`);
            this.requestNextPiece(peerClient);
        });

        peerClient.on('piece', (pieceData) => {
            this.handlePieceData(pieceData, peerClient);
        });

        peerClient.on('disconnected', () => {
            console.log(`📡 Peer desconectado: ${peerClient.getPeerInfo().ip}`);
            this.removePeer(peerClient);
        });

        peerClient.on('error', (error) => {
            console.error(`❌ Error del peer ${peerClient.getPeerInfo().ip}: ${error.message}`);
            this.removePeer(peerClient);
        });
    }

    /**
     * Descarga piezas de forma secuencial
     */
    private async downloadSequentially(): Promise<void> {
        console.log('📥 Iniciando descarga con estrategia distribuida...');
        let reconnectAttempts = 0;
        const MAX_RECONNECT_ATTEMPTS = 5;

        // Mapa para almacenar los bitfields de cada peer
        const peerBitfields = new Map<string, boolean[]>();

        // Configurar evento para capturar bitfields
        this.activePeers.forEach(peer => {
            peer.on('bitfield', (bitfield) => {
                const peerInfo = peer.getPeerInfo();
                const peerKey = `${peerInfo.ip}:${peerInfo.port}`;
                const boolArray = BufferUtils.bitfieldToArray(bitfield, this.torrentParser.getMetadata().pieceCount);
                peerBitfields.set(peerKey, boolArray);
            });
        });

        return new Promise((resolve, reject) => {
            const checkProgress = async () => {
                if (this.pieceManager.isDownloadComplete()) {
                    console.log('🎉 ¡Descarga completada!');
                    this.downloadComplete = true;
                    resolve();
                    return;
                }

                // Ordenar peers por velocidad de descarga
                this.activePeers.sort((a, b) => b.getDownloadSpeed() - a.getDownloadSpeed());

                // Distribuir solicitudes entre todos los peers disponibles
                let requestsMade = 0;
                for (const peer of this.activePeers) {
                    if (peer.isConnected() && !peer.isChoked()) {
                        // Intentar solicitar hasta 3 piezas por peer en cada ciclo
                        for (let i = 0; i < 3; i++) {
                            if (this.requestPieceFromPeer(peer, peerBitfields)) {
                                requestsMade++;
                            }
                        }
                    }
                }

                // Mostrar estadísticas
                const stats = this.pieceManager.getStats();
                console.log(`📊 Progreso: ${stats.percentage.toFixed(1)}% (${stats.completed}/${stats.total} piezas) - Solicitudes: ${requestsMade}`);

                // Verificar si necesitamos más peers
                if (this.activePeers.length < 5 || requestsMade === 0) {
                    console.log(`🔍 Buscando más peers (activos: ${this.activePeers.length})...`);

                    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                        console.log(`⚠️ Máximo de intentos de reconexión alcanzado, continuando con los peers disponibles`);
                    } else {
                        reconnectAttempts++;
                        try {
                            const newPeers = await this.trackerClient.getPeers(this.torrentParser.getMetadata());
                            if (newPeers.length > 0) {
                                console.log(`👥 Encontrados ${newPeers.length} nuevos peers`);
                                // Conectar a más peers (hasta 50)
                                await this.connectToPeers(newPeers.slice(0, 50));
                            }
                        } catch (error) {
                            if (error instanceof Error)
                                console.log(`⚠️ Error buscando peers: ${error.message}`);
                        }
                    }
                }

                // Continuar verificando
                setTimeout(checkProgress, 2000);
            };

            // Iniciar verificación
            checkProgress();
        });
    }

    // Nuevo método para solicitar piezas a un peer específico
    private requestPieceFromPeer(peer: PeerClient, peerBitfields: Map<string, boolean[]>): boolean {
        // Obtener la pieza más rara que este peer tenga
        const peerInfo = peer.getPeerInfo();
        const peerKey = `${peerInfo.ip}:${peerInfo.port}`;

        // Si tenemos el bitfield de este peer, usarlo para la estrategia rarest-first
        if (peerBitfields.has(peerKey)) {
            const piece = this.pieceManager.getRarestPiece(peerBitfields);

            if (piece && !this.piecesInProgress.has(piece.index)) {
                const bitfield = peerBitfields.get(peerKey)!;

                // Verificar si este peer tiene la pieza
                if (bitfield[piece.index]) {
                    console.log(`📤 Solicitando pieza rara ${piece.index} a ${peerInfo.ip}`);
                    this.piecesInProgress.add(piece.index);
                    peer.requestPiece(piece.index, piece.size);
                    return true;
                }
            }
        }

        // Fallback: solicitar la siguiente pieza secuencial
        const piece = this.pieceManager.getNextPieceToDownload();
        if (piece && !this.piecesInProgress.has(piece.index)) {
            console.log(`📤 Solicitando pieza secuencial ${piece.index} a ${peerInfo.ip}`);
            this.piecesInProgress.add(piece.index);
            peer.requestPiece(piece.index, piece.size);
            return true;
        }

        return false;
    }

    /**
     * Maneja datos de pieza recibidos (CORREGIDO)
     */
    // Añadir como propiedad de la clase

    // Modificar el método handlePieceData
    private async handlePieceData(pieceData: any, peerClient: PeerClient): Promise<void> {
        const { index: pieceIndex, begin: offset, block } = pieceData;

        // Limpiar timeout si existe
        if (this.pieceTimeouts.has(pieceIndex)) {
            clearTimeout(this.pieceTimeouts.get(pieceIndex)!);
            this.pieceTimeouts.delete(pieceIndex);
        }

        // Añadir bloque a la pieza
        const pieceCompleted = this.pieceManager.addBlockToPiece(pieceIndex, offset, block);

        if (pieceCompleted) {
            // Remover de piezas en progreso
            this.piecesInProgress.delete(pieceIndex);

            // Escribir pieza al archivo
            const pieceData = this.pieceManager.getPieceData(pieceIndex);
            if (pieceData) {
                await this.fileManager.writePiece(pieceIndex, pieceData);
            }

            // Solicitar más piezas a este peer (ya que respondió bien)
            for (let i = 0; i < 3; i++) {
                if (peerClient.isConnected() && !peerClient.isChoked()) {
                    this.requestNextPiece(peerClient);
                }
            }
        }
    }

    // Modificar el método requestNextPiece
    private requestNextPiece(peerClient: PeerClient): void {
        const piece = this.pieceManager.getNextPieceToDownload();

        if (piece && !this.piecesInProgress.has(piece.index)) {
            console.log(`📤 Solicitando pieza ${piece.index} a ${peerClient.getPeerInfo().ip}`);
            this.piecesInProgress.add(piece.index);
            peerClient.requestPiece(piece.index, piece.size);

            // Establecer timeout para esta pieza
            const timeout = setTimeout(() => {
                console.log(`⏱️ Timeout para pieza ${piece.index}, liberando para reintento`);
                this.pieceManager.resetPieceRequest(piece.index);
                this.piecesInProgress.delete(piece.index);
            }, 30000); // 30 segundos

            this.pieceTimeouts.set(piece.index, timeout);
        }
    }

    /**
     * Remueve un peer de la lista activa
     */
    private removePeer(peerClient: PeerClient): void {
        const index = this.activePeers.indexOf(peerClient);
        if (index > -1) {
            const peerInfo = peerClient.getPeerInfo();
            console.log(`🔌 Removiendo peer ${peerInfo.ip}:${peerInfo.port}`);

            this.activePeers.splice(index, 1);

            // Liberar todas las piezas que este peer estaba descargando
            // (Esto es crucial para evitar que la descarga se quede atascada)
            for (const pieceIndex of this.piecesInProgress) {
                const piece = this.pieceManager.getPieceInfo(pieceIndex);
                if (piece && !piece.completed) {
                    console.log(`🔄 Liberando pieza ${pieceIndex} para reintento`);
                    this.pieceManager.resetPieceRequest(pieceIndex);
                    this.piecesInProgress.delete(pieceIndex);

                    // Limpiar timeout si existe
                    if (this.pieceTimeouts.has(pieceIndex)) {
                        clearTimeout(this.pieceTimeouts.get(pieceIndex)!);
                        this.pieceTimeouts.delete(pieceIndex);
                    }
                }
            }

            peerClient.disconnect();
        }
    }

    /**
     * Finaliza la descarga
     */
    private async finishDownload(): Promise<void> {
        console.log('🏁 Finalizando descarga...');

        // Verificar integridad del archivo
        const isValid = await this.fileManager.verifyFile();
        if (!isValid) {
            throw new Error('Verificación de integridad del archivo fallida');
        }

        // Notificar al tracker que completamos la descarga
        await this.trackerClient.announceComplete(this.torrentParser.getMetadata());

        // Finalizar archivo
        await this.fileManager.finalize();

        console.log('🎯 ¡Descarga completada exitosamente!');
        console.log(`📁 Archivo guardado en: ${this.fileManager.getFilePath()}`);
    }

    /**
     * Limpia recursos
     */
    private async cleanup(): Promise<void> {
        console.log('🧹 Limpiando recursos...');

        // Desconectar todos los peers
        for (const peer of this.activePeers) {
            peer.disconnect();
        }
        this.activePeers = [];

        // Cerrar archivo
        await this.fileManager.cleanup();

        // Notificar stop al tracker
        try {
            await this.trackerClient.announceStop(this.torrentParser.getMetadata());
        } catch (error) {
            if (error instanceof Error) {

                console.log(`⚠️ Error notificando stop: ${error.message}`);
            }
        }
    }

}

/**
 * CLI principal
 */
async function main() {
    // const args = process.argv.slice(2);

    // if (args.length < 1) {
    //     console.log('Uso: npm start <archivo.torrent> [directorio_descarga]');
    //     console.log('Ejemplo: npm start ejemplo.torrent ./downloads');
    //     process.exit(1);
    // }

    const torrentPath = './torrents/maincra.torrent'; // args[0];
    const outputDir = './downloads';

    try {
        const client = new SimpleTorrentClient(torrentPath, outputDir);
        await client.startDownload();

        console.log('✨ Descarga finalizada exitosamente');
        process.exit(0);

    } catch (error) {
        if (error instanceof Error) {

            console.error(`💥 Error fatal: ${error.message}`);
        }
        process.exit(1);
    }
}

// Ejecutar si es el módulo principal
if (require.main === module) {
    main().catch(console.error);
}

// export { SimpleTorrentClient };