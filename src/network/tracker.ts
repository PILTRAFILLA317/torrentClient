import * as http from 'http';
import * as https from 'https';
import * as dgram from 'dgram';
import * as url from 'url';
import { BencodeParser } from '../parsers/bencode';
import { TrackerResponse, PeerInfo } from '../types/tracker_types';
import { TorrentMetadata } from '../types/torrent_types';
import { CryptoUtils } from '../utils/crypto';
import { BufferUtils } from '../utils/buffer';

/**
 * Cliente para comunicarse con trackers BitTorrent (HTTP/HTTPS/UDP)
 */
export class TrackerClient {
    private peerId: Buffer;
    private port: number;
    private uploaded: number = 0;
    private downloaded: number = 0;
    private left: number;

    // Constantes para UDP tracker
    private static readonly UDP_MAGIC_CONSTANT = Buffer.from([0x00, 0x00, 0x04, 0x17, 0x27, 0x10, 0x19, 0x80]);
    private static readonly UDP_ACTION_CONNECT = 0;
    private static readonly UDP_ACTION_ANNOUNCE = 1;

    constructor(torrentMetadata: TorrentMetadata, port: number = 6881) {
        this.peerId = CryptoUtils.generatePeerId();
        this.port = port;
        this.left = torrentMetadata.totalLength;

        console.log(`🔑 Peer ID generado: ${this.peerId.toString()}`);
    }

    /**
     * Obtiene lista de peers del tracker
     */
    async getPeers(
        torrentMetadata: TorrentMetadata,
        event: 'started' | 'stopped' | 'completed' | undefined = 'started'
    ): Promise<Array<{ ip: string; port: number }>> {
        console.log(`🔍 Contactando trackers en paralelo para obtener peers...`);

        // Crear un array de promesas para contactar a todos los trackers simultáneamente
        const trackerPromises = torrentMetadata.announceList.map(async (trackerUrl) => {
            try {
                console.log(`📡 Contactando tracker: ${trackerUrl}`);

                let peers: Array<{ ip: string; port: number }> = [];

                if (trackerUrl.startsWith('udp://')) {
                    peers = await this.contactUdpTracker(trackerUrl, torrentMetadata, event);
                } else if (trackerUrl.startsWith('http://') || trackerUrl.startsWith('https://')) {
                    peers = await this.contactHttpTracker(trackerUrl, torrentMetadata, event);
                } else {
                    console.log(`⚠️ Protocolo no soportado para: ${trackerUrl}`);
                    return [];
                }

                if (peers.length > 0) {
                    console.log(`✅ Tracker ${trackerUrl} respondió con ${peers.length} peers`);
                } else {
                    console.log(`ℹ️ Tracker ${trackerUrl} no devolvió peers`);
                }

                return peers;
            } catch (error) {
                if (error instanceof Error) {
                    console.log(`❌ Error con tracker ${trackerUrl}: ${error.message}`);
                }
                return []; // Devolver array vacío en caso de error
            }
        });

        // Esperar a que todas las promesas se resuelvan (con Promise.allSettled para manejar errores)
        const results = await Promise.allSettled(trackerPromises);

        // Recopilar todos los peers de los trackers que respondieron exitosamente
        const allPeers: Array<{ ip: string; port: number }> = [];
        const uniquePeers = new Map<string, { ip: string; port: number }>();

        results.forEach((result) => {
            if (result.status === 'fulfilled' && result.value.length > 0) {
                result.value.forEach(peer => {
                    const peerKey = `${peer.ip}:${peer.port}`;
                    if (!uniquePeers.has(peerKey)) {
                        uniquePeers.set(peerKey, peer);
                    }
                });
            }
        });

        // Convertir el Map a array
        const uniquePeersList = Array.from(uniquePeers.values());

        if (uniquePeersList.length === 0) {
            throw new Error('No se pudo obtener peers de ningún tracker');
        }

        console.log(`✅ Total: ${uniquePeersList.length} peers únicos obtenidos de todos los trackers`);
        return uniquePeersList;
    }

    // async getPeers(metadata: TorrentMetadata): Promise<Array<{ ip: string; port: number }>> {
    //     const announceList = metadata.announceList;

    //     // Realizar solicitudes a todos los trackers en paralelo
    //     const peerLists = await Promise.all(
    //         announceList.map(async (trackerUrl) => {
    //             try {
    //                 const peers = await this.announce(trackerUrl, metadata, 'started');
    //                 console.log(`✅ Tracker ${trackerUrl} respondió con ${peers.length} peers`);
    //                 return peers;
    //             } catch (error) {
    //                 if (error instanceof Error) {
    //                     console.error(`⚠️ Error con tracker ${trackerUrl}: ${error.message}`);
    //                 }
    //                 return [];
    //             }
    //         })
    //     );

    //     // Combinar todas las listas de peers en una sola
    //     return peerLists.flat();
    // }

    /**
     * Contacta un tracker UDP
     */
    private async contactUdpTracker(
        trackerUrl: string,
        torrentMetadata: TorrentMetadata,
        event?: string
    ): Promise<Array<{ ip: string; port: number }>> {

        const parsedUrl = url.parse(trackerUrl);
        const host = parsedUrl.hostname;
        const port = parseInt(parsedUrl.port || '80');

        if (!host) {
            throw new Error('Host inválido en URL UDP');
        }

        console.log(`🔌 Conectando a tracker UDP: ${host}:${port}`);

        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            let connectionId: Buffer | null = null;
            let transactionId: number;

            // Timeout general
            const timeout = setTimeout(() => {
                socket.close();
                reject(new Error('Timeout conectando a tracker UDP'));
            }, 15000);

            socket.on('error', (error) => {
                clearTimeout(timeout);
                socket.close();
                reject(error);
            });

            socket.on('message', async (message) => {
                try {
                    if (!connectionId) {
                        // Respuesta al connect request
                        const response = this.parseUdpConnectResponse(message, transactionId);
                        connectionId = response.connectionId;

                        console.log(`🔗 Conexión UDP establecida, enviando announce...`);

                        // Enviar announce request
                        const announceRequest = this.createUdpAnnounceRequest(
                            connectionId,
                            torrentMetadata,
                            event
                        );

                        transactionId = announceRequest.transactionId;
                        socket.send(announceRequest.buffer, port, host);

                    } else {
                        // Respuesta al announce request
                        const peers = this.parseUdpAnnounceResponse(message, transactionId);

                        clearTimeout(timeout);
                        socket.close();
                        resolve(peers);
                    }
                } catch (error) {
                    clearTimeout(timeout);
                    socket.close();
                    reject(error);
                }
            });

            // Enviar connect request inicial
            const connectRequest = this.createUdpConnectRequest();
            transactionId = connectRequest.transactionId;

            socket.send(connectRequest.buffer, port, host, (error) => {
                if (error) {
                    clearTimeout(timeout);
                    socket.close();
                    reject(error);
                }
            });
        });
    }

    /**
     * Crea request de conexión UDP
     */
    private createUdpConnectRequest(): { buffer: Buffer; transactionId: number } {
        const transactionId = Math.floor(Math.random() * 0xFFFFFFFF);

        const buffer = Buffer.alloc(16);
        let offset = 0;

        // Magic constant (8 bytes)
        TrackerClient.UDP_MAGIC_CONSTANT.copy(buffer, offset);
        offset += 8;

        // Action: connect (4 bytes)
        buffer.writeUInt32BE(TrackerClient.UDP_ACTION_CONNECT, offset);
        offset += 4;

        // Transaction ID (4 bytes)
        buffer.writeUInt32BE(transactionId, offset);

        return { buffer, transactionId };
    }

    /**
     * Parsea respuesta de conexión UDP
     */
    private parseUdpConnectResponse(message: Buffer, expectedTransactionId: number): { connectionId: Buffer } {
        if (message.length < 16) {
            throw new Error('Respuesta de conexión UDP demasiado corta');
        }

        const action = message.readUInt32BE(0);
        const transactionId = message.readUInt32BE(4);
        const connectionId = message.slice(8, 16);

        if (action !== TrackerClient.UDP_ACTION_CONNECT) {
            throw new Error(`Acción incorrecta en respuesta UDP: ${action}`);
        }

        if (transactionId !== expectedTransactionId) {
            throw new Error('Transaction ID no coincide en respuesta UDP');
        }

        return { connectionId };
    }

    /**
     * Crea request de announce UDP
     */
    private createUdpAnnounceRequest(
        connectionId: Buffer,
        torrentMetadata: TorrentMetadata,
        event?: string
    ): { buffer: Buffer; transactionId: number } {

        const transactionId = Math.floor(Math.random() * 0xFFFFFFFF);
        const buffer = Buffer.alloc(98);
        let offset = 0;

        // Connection ID (8 bytes)
        connectionId.copy(buffer, offset);
        offset += 8;

        // Action: announce (4 bytes)
        buffer.writeUInt32BE(TrackerClient.UDP_ACTION_ANNOUNCE, offset);
        offset += 4;

        // Transaction ID (4 bytes)
        buffer.writeUInt32BE(transactionId, offset);
        offset += 4;

        // Info hash (20 bytes)
        torrentMetadata.infoHash.copy(buffer, offset);
        offset += 20;

        // Peer ID (20 bytes)
        this.peerId.copy(buffer, offset);
        offset += 20;

        // Downloaded (8 bytes)
        buffer.writeBigUInt64BE(BigInt(this.downloaded), offset);
        offset += 8;

        // Left (8 bytes)
        buffer.writeBigUInt64BE(BigInt(this.left), offset);
        offset += 8;

        // Uploaded (8 bytes)
        buffer.writeBigUInt64BE(BigInt(this.uploaded), offset);
        offset += 8;

        // Event (4 bytes)
        let eventValue = 0; // none
        if (event === 'started') eventValue = 2;
        else if (event === 'completed') eventValue = 1;
        else if (event === 'stopped') eventValue = 3;
        buffer.writeUInt32BE(eventValue, offset);
        offset += 4;

        // IP address (4 bytes) - 0 = default
        buffer.writeUInt32BE(0, offset);
        offset += 4;

        // Key (4 bytes) - random
        buffer.writeUInt32BE(Math.floor(Math.random() * 0xFFFFFFFF), offset);
        offset += 4;

        // Num want (4 bytes)
        buffer.writeUInt32BE(50, offset);
        offset += 4;

        // Port (2 bytes)
        buffer.writeUInt16BE(this.port, offset);

        return { buffer, transactionId };
    }

    /**
     * Parsea respuesta de announce UDP
     */
    private parseUdpAnnounceResponse(message: Buffer, expectedTransactionId: number): Array<{ ip: string; port: number }> {
        if (message.length < 20) {
            throw new Error('Respuesta de announce UDP demasiado corta');
        }

        const action = message.readUInt32BE(0);
        const transactionId = message.readUInt32BE(4);

        if (action !== TrackerClient.UDP_ACTION_ANNOUNCE) {
            // Podría ser un error
            if (action === 3 && message.length >= 8) {
                const errorMessage = message.slice(8).toString();
                throw new Error(`Error del tracker UDP: ${errorMessage}`);
            }
            throw new Error(`Acción incorrecta en respuesta UDP announce: ${action}`);
        }

        if (transactionId !== expectedTransactionId) {
            throw new Error('Transaction ID no coincide en respuesta UDP announce');
        }

        const interval = message.readUInt32BE(8);
        const leechers = message.readUInt32BE(12);
        const seeders = message.readUInt32BE(16);

        console.log(`📊 Tracker UDP - Seeders: ${seeders}, Leechers: ${leechers}, Interval: ${interval}s`);

        // Parsear peers (formato compacto)
        const peersData = message.slice(20);
        return BufferUtils.parsePeersCompact(peersData);
    }

    /**
     * Contacta un tracker HTTP/HTTPS (método existente)
     */
    private async contactHttpTracker(
        trackerUrl: string,
        torrentMetadata: TorrentMetadata,
        event?: string
    ): Promise<Array<{ ip: string; port: number }>> {

        const params = new URLSearchParams({
            info_hash: torrentMetadata.infoHash.toString('binary'),
            peer_id: this.peerId.toString('binary'),
            port: this.port.toString(),
            uploaded: this.uploaded.toString(),
            downloaded: this.downloaded.toString(),
            left: this.left.toString(),
            compact: '1',
            numwant: '50',
        });

        if (event) {
            params.set('event', event);
        }

        const requestUrl = `${trackerUrl}?${params.toString()}`;

        return new Promise((resolve, reject) => {
            const parsedUrl = url.parse(requestUrl);
            const client = parsedUrl.protocol === 'https:' ? https : http;

            const request = client.get(requestUrl, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                    return;
                }

                const chunks: Buffer[] = [];

                response.on('data', (chunk) => {
                    chunks.push(chunk);
                });

                response.on('end', () => {
                    try {
                        const responseBuffer = Buffer.concat(chunks);
                        const trackerResponse = this.parseTrackerResponse(responseBuffer);
                        const peers = this.extractPeers(trackerResponse);
                        resolve(peers);
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            request.on('error', (error) => {
                reject(error);
            });

            request.setTimeout(10000, () => {
                request.destroy();
                reject(new Error('Timeout al contactar tracker HTTP'));
            });
        });
    }

    /**
     * Parsea la respuesta del tracker HTTP
     */
    private parseTrackerResponse(responseBuffer: Buffer): TrackerResponse {
        try {
            const decoded = BencodeParser.decode(responseBuffer) as any;

            if (decoded['failure reason']) {
                throw new Error(`Tracker error: ${decoded['failure reason']}`);
            }

            return {
                interval: decoded.interval || 1800,
                'min interval': decoded['min interval'],
                'tracker id': decoded['tracker id'],
                complete: decoded.complete || 0,
                incomplete: decoded.incomplete || 0,
                peers: decoded.peers,
                'failure reason': decoded['failure reason'],
                'warning message': decoded['warning message'],
            };
        } catch (error) {
            if (error instanceof Error) {

                throw new Error(`Error parseando respuesta del tracker: ${error.message}`);
            }
            throw new Error('Error parseando respuesta del tracker: formato inválido');
        }
    }

    /**
     * Extrae peers de la respuesta del tracker HTTP
     */
    private extractPeers(response: TrackerResponse): Array<{ ip: string; port: number }> {
        if (!response.peers) {
            return [];
        }

        if (Buffer.isBuffer(response.peers)) {
            return BufferUtils.parsePeersCompact(response.peers);
        }

        if (Array.isArray(response.peers)) {
            return (response.peers as PeerInfo[]).map(peer => ({
                ip: peer.ip,
                port: peer.port,
            }));
        }

        return [];
    }

    /**
     * Actualiza estadísticas de descarga
     */
    updateStats(uploaded: number, downloaded: number, left: number): void {
        this.uploaded = uploaded;
        this.downloaded = downloaded;
        this.left = left;
    }

    /**
     * Notifica al tracker sobre el evento de parada
     */
    async announceStop(torrentMetadata: TorrentMetadata): Promise<void> {
        try {
            await this.getPeers(torrentMetadata, 'stopped');
            console.log('📡 Notificado stop al tracker');
        } catch (error) {
            if (error instanceof Error) {

                console.log(`⚠️ Error notificando stop: ${error.message}`);
            }
        }
    }

    /**
     * Notifica al tracker sobre la finalización
     */
    async announceComplete(torrentMetadata: TorrentMetadata): Promise<void> {
        try {
            await this.getPeers(torrentMetadata, 'completed');
            console.log('🎉 Notificado completed al tracker');
        } catch (error) {
            if (error instanceof Error) {

                console.log(`⚠️ Error notificando completed: ${error.message}`);
            }
        }
    }
}