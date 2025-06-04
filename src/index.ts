import * as fs from 'fs';
import * as path from 'path';
import { TorrentParser } from './core/torrent';
import { TrackerClient } from './network/tracker';
import { PeerClient } from './network/peer';
import { PieceManager } from './core/piece-manager';
import { FileManager } from './core/file-manager';
import { CryptoUtils } from './utils/crypto';

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
            await this.connectToPeers(peers.slice(0, 20));

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

        for (const peerInfo of peerList) {
            const peerKey = `${peerInfo.ip}:${peerInfo.port}`;
            if (this.failedPeers.has(peerKey)) {
                console.log(`⚠️ Peer ${peerKey} ya rechazó la conexión anteriormente. Ignorando.`);
                continue;
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

                // Configurar eventos del peer
                this.setupPeerEvents(peerClient);

                // Intentar conectar
                await peerClient.connect();
                this.activePeers.push(peerClient);
            } catch (error) {
                if (error instanceof Error)
                    console.log(`⚠️ No se pudo conectar a ${peerInfo.ip}:${peerInfo.port} - ${error.message}`);
                this.failedPeers.add(peerKey); // Marcar peer como fallido
            }
        }

        console.log(`✅ Conectado a ${this.activePeers.length} peers`);
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
        console.log('📥 Iniciando descarga secuencial...');

        return new Promise((resolve, reject) => {
            const checkProgress = async () => {
                if (this.pieceManager.isDownloadComplete()) {
                    console.log('🎉 ¡Descarga completada!');
                    this.downloadComplete = true;
                    resolve();
                    return;
                }

                // Solicitar siguiente pieza a peers disponibles
                for (const peer of this.activePeers) {
                    if (peer.isConnected() && !peer.isChoked()) {
                        this.requestNextPiece(peer);
                    }
                }

                // Mostrar progreso cada 5 segundos
                const stats = this.pieceManager.getStats();
                console.log(`📊 Progreso: ${stats.percentage.toFixed(1)}% (${stats.completed}/${stats.total} piezas)`);

                // Si no hay peers activos, buscar más
                if (this.activePeers.length === 0) {
                    console.log('🔄 Todos los peers se desconectaron. Buscando más peers...');
                    try {
                        const newPeers = await this.trackerClient.getPeers(this.torrentParser.getMetadata());
                        if (newPeers.length > 0) {
                            console.log(`👥 Encontrados ${newPeers.length} nuevos peers`);
                            await this.connectToPeers(newPeers.slice(0, 20)); // Conectar a un máximo de 20 nuevos peers
                        } else {
                            console.error('❌ No se encontraron más peers disponibles');
                            reject(new Error('Todos los peers se desconectaron y no se encontraron más peers'));
                            return;
                        }
                    } catch (error) {
                        if (error instanceof Error)
                            console.error(`❌ Error buscando más peers: ${error.message}`);
                        reject(error);
                        return;
                    }
                }

                // Continuar verificando en 2 segundos
                setTimeout(checkProgress, 2000);
            };

            // Iniciar verificación
            checkProgress();
        });
    }

    /**
     * Solicita la siguiente pieza a un peer específico
     */
    private requestNextPiece(peerClient: PeerClient): void {
        const piece = this.pieceManager.getNextPieceToDownload();

        if (piece && peerClient.hasPiece(piece.index) && !this.piecesInProgress.has(piece.index)) {
            console.log(`📤 Solicitando pieza ${piece.index} a ${peerClient.getPeerInfo().ip}`);
            this.piecesInProgress.add(piece.index);
            peerClient.requestPiece(piece.index, piece.size);
        }
    }

    /**
     * Maneja datos de pieza recibidos (CORREGIDO)
     */
    private async handlePieceData(pieceData: any, peerClient: PeerClient): Promise<void> {
        const { index: pieceIndex, begin: offset, block } = pieceData;

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

            // Solicitar siguiente pieza
            this.requestNextPiece(peerClient);
        }
    }

    /**
     * Remueve un peer de la lista activa
     */
    private removePeer(peerClient: PeerClient): void {
        const index = this.activePeers.indexOf(peerClient);
        if (index > -1) {
            this.activePeers.splice(index, 1);
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

    const torrentPath = './torrents/tracker--HDTV-temp-2-x-cap-1_17_12248.torrent'; // args[0];
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