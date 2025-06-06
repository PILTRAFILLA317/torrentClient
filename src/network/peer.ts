import * as net from 'net';
import { EventEmitter } from 'events';
import { MessageType, PeerMessage, PieceRequest, PieceData } from '../types/peer_types';
import { Peer } from '../types/tracker_types';
import { TorrentMetadata } from '../types/torrent_types';
import { BufferUtils } from '../utils/buffer';

/**
 * Cliente para comunicarse con peers usando el protocolo BitTorrent
 */
export class PeerClient extends EventEmitter {
  private peer: Peer;
  private metadata: TorrentMetadata;
  private peerId: Buffer;
  private socket: net.Socket | null = null;
  private connected: boolean = false;
  private handshakeCompleted: boolean = false;
  private messageBuffer: Buffer = Buffer.alloc(0);
  private downloadSpeed: number = 0;
  private bytesDownloaded: number = 0;
  private lastSpeedCalculation: number = Date.now();

  // Constantes del protocolo
  private static readonly PROTOCOL_STRING = 'BitTorrent protocol';
  private static readonly HANDSHAKE_LENGTH = 68;
  private static readonly BLOCK_SIZE = 16384; // 16KB por bloque

  constructor(peer: Peer, metadata: TorrentMetadata, peerId: Buffer) {
    super();
    this.peer = peer;
    this.metadata = metadata;
    this.peerId = peerId;
  }

  /**
   * Conecta al peer
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`🔗 Conectando a peer ${this.peer.ip}:${this.peer.port}`);

      this.socket = new net.Socket();
      this.setupSocketEvents();

      // Timeout de conexión
      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error('Timeout de conexión'));
      }, 10000);

      this.socket.connect(this.peer.port, this.peer.ip, () => {
        clearTimeout(timeout);
        this.connected = true;
        console.log(`✅ Conectado a peer ${this.peer.ip}:${this.peer.port}`);

        // Enviar handshake inmediatamente después de conectar
        this.sendHandshake();
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Configura eventos del socket
   */
  private setupSocketEvents(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      this.handleData(data);
    });

    this.socket.on('close', () => {
      console.log(`🔌 Conexión cerrada con peer ${this.peer.ip}:${this.peer.port}`);
      this.connected = false;
      this.emit('disconnected');
    });

    this.socket.on('error', (error) => {
      console.error(`❌ Error de socket con peer ${this.peer.ip}:${this.peer.port}: ${error.message}`);
      this.emit('error', error);
    });
  }

  /**
   * Envía el handshake inicial
   */
  private sendHandshake(): void {
    const protocolLength = Buffer.from([PeerClient.PROTOCOL_STRING.length]);
    const protocol = Buffer.from(PeerClient.PROTOCOL_STRING);
    const reserved = Buffer.alloc(8); // 8 bytes reservados (todos ceros)
    const infoHash = this.metadata.infoHash;
    const peerId = this.peerId;

    const handshake = Buffer.concat([
      protocolLength,
      protocol,
      reserved,
      infoHash,
      peerId
    ]);

    this.sendData(handshake);
    console.log(`🤝 Handshake enviado a ${this.peer.ip}:${this.peer.port}`);
  }

  /**
   * Maneja datos recibidos del peer
   */
  private handleData(data: Buffer): void {
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);

    // Procesar handshake si no se ha completado
    if (!this.handshakeCompleted && this.messageBuffer.length >= PeerClient.HANDSHAKE_LENGTH) {
      this.handleHandshake();
    }

    // Procesar mensajes después del handshake
    if (this.handshakeCompleted) {
      this.processMessages();
    }
  }

  /**
   * Procesa el handshake recibido
   */
  private handleHandshake(): void {
    const handshake = this.messageBuffer.slice(0, PeerClient.HANDSHAKE_LENGTH);
    this.messageBuffer = this.messageBuffer.slice(PeerClient.HANDSHAKE_LENGTH);

    // Validar handshake
    const protocolLength = handshake[0];
    const protocol = handshake.slice(1, 1 + protocolLength).toString();
    const infoHash = handshake.slice(28, 48);
    const peerId = handshake.slice(48, 68);

    if (protocol !== PeerClient.PROTOCOL_STRING) {
      this.emit('error', new Error('Protocolo inválido en handshake'));
      return;
    }

    if (!infoHash.equals(this.metadata.infoHash)) {
      this.emit('error', new Error('Info hash no coincide'));
      return;
    }

    this.peer.id = peerId;
    this.handshakeCompleted = true;

    console.log(`🤝 Handshake completado con ${this.peer.ip}:${this.peer.port}`);

    // Enviar mensaje de interés
    this.sendInterested();
    this.emit('connected');
  }

  /**
   * Procesa mensajes del protocolo BitTorrent
   */
  private processMessages(): void {
    while (this.messageBuffer.length >= 4) {
      // Leer longitud del mensaje
      const messageLength = BufferUtils.readUInt32BE(this.messageBuffer, 0);

      // Keep-alive message (longitud 0)
      if (messageLength === 0) {
        this.messageBuffer = this.messageBuffer.slice(4);
        console.log(`💓 Keep-alive recibido de ${this.peer.ip}`);
        continue;
      }

      // Verificar si tenemos el mensaje completo
      if (this.messageBuffer.length < 4 + messageLength) {
        break; // Esperar más datos
      }

      // Extraer mensaje
      const messageData = this.messageBuffer.slice(4, 4 + messageLength);
      this.messageBuffer = this.messageBuffer.slice(4 + messageLength);

      const messageType = messageData[0] as MessageType;
      const payload = messageData.slice(1);

      this.handleMessage(messageType, payload);
    }
  }

  /**
   * Maneja mensajes específicos del protocolo
   */
  private handleMessage(messageType: MessageType, payload: Buffer): void {
    switch (messageType) {
      case MessageType.CHOKE:
        this.peer.choked = true;
        console.log(`😴 Choked por ${this.peer.ip}`);
        break;

      case MessageType.UNCHOKE:
        this.peer.choked = false;
        console.log(`😊 Unchoked por ${this.peer.ip}`);
        this.emit('unchoked');
        break;

      case MessageType.INTERESTED:
        this.peer.peerInterested = true;
        console.log(`😍 Peer ${this.peer.ip} está interesado`);
        break;

      case MessageType.NOT_INTERESTED:
        this.peer.peerInterested = false;
        console.log(`😐 Peer ${this.peer.ip} no está interesado`);
        break;

      case MessageType.HAVE:
        if (payload.length === 4) {
          const pieceIndex = BufferUtils.readUInt32BE(payload, 0);
          console.log(`📦 Peer ${this.peer.ip} tiene pieza ${pieceIndex}`);
          this.emit('have', pieceIndex);
        }
        break;

      case MessageType.BITFIELD:
        this.peer.bitfield = payload;
        console.log(`🗂️ Bitfield recibido de ${this.peer.ip} (${payload.length} bytes)`);
        this.emit('bitfield', payload);
        break;

      case MessageType.PIECE:
        this.handlePieceMessage(payload);
        break;

      default:
        console.log(`❓ Mensaje desconocido tipo ${messageType} de ${this.peer.ip}`);
    }
  }

  /**
   * Maneja mensajes de pieza recibidos
   */
  private handlePieceMessage(payload: Buffer): void {
    if (payload.length < 8) {
      console.error('❌ Mensaje de pieza demasiado corto');
      return;
    }

    const pieceIndex = BufferUtils.readUInt32BE(payload, 0);
    const begin = BufferUtils.readUInt32BE(payload, 4);
    const block = payload.slice(8);

    // Actualizar bytes descargados para cálculo de velocidad
    this.bytesDownloaded += block.length;

    // Calcular velocidad cada 10 segundos
    const now = Date.now();
    if (now - this.lastSpeedCalculation > 10000) {
      const timeElapsed = (now - this.lastSpeedCalculation) / 1000;
      this.downloadSpeed = this.bytesDownloaded / timeElapsed;
      this.bytesDownloaded = 0;
      this.lastSpeedCalculation = now;
      console.log(`📊 Velocidad de ${this.peer.ip}: ${(this.downloadSpeed / 1024).toFixed(2)} KB/s`);
    }

    const pieceData: PieceData = {
      index: pieceIndex,
      begin,
      block
    };

    console.log(`📥 Bloque recibido: pieza ${pieceIndex}, offset ${begin}, tamaño ${block.length}`);
    this.emit('piece', pieceData);
  }

  /**
   * Envía mensaje de interés
   */
  private sendInterested(): void {
    const message = this.createMessage(MessageType.INTERESTED);
    this.sendData(message);
    this.peer.interested = true;
    console.log(`😍 Enviado INTERESTED a ${this.peer.ip}`);
  }

  /**
   * Solicita una pieza específica
   */
  requestPiece(pieceIndex: number, pieceLength: number): void {
    if (this.peer.choked) {
      console.log(`⏸️ No se puede solicitar pieza ${pieceIndex}: peer choked`);
      return;
    }

    console.log(`📤 Solicitando pieza ${pieceIndex} (${pieceLength} bytes)`);

    // Solicitar la pieza en bloques de 16KB
    let offset = 0;
    while (offset < pieceLength) {
      const blockSize = Math.min(PeerClient.BLOCK_SIZE, pieceLength - offset);
      this.requestBlock(pieceIndex, offset, blockSize);
      offset += blockSize;
    }
  }

  /**
   * Solicita un bloque específico de una pieza
   */
  private requestBlock(pieceIndex: number, begin: number, length: number): void {
    const payload = Buffer.concat([
      BufferUtils.writeUInt32BE(pieceIndex),
      BufferUtils.writeUInt32BE(begin),
      BufferUtils.writeUInt32BE(length)
    ]);

    const message = this.createMessage(MessageType.REQUEST, payload);
    this.sendData(message);
  }

  /**
   * Crea un mensaje del protocolo BitTorrent
   */
  private createMessage(messageType: MessageType, payload?: Buffer): Buffer {
    const payloadLength = payload ? payload.length : 0;
    const messageLength = payloadLength + 1; // +1 para el tipo de mensaje

    const lengthBuffer = BufferUtils.writeUInt32BE(messageLength);
    const typeBuffer = Buffer.from([messageType]);

    if (payload) {
      return Buffer.concat([lengthBuffer, typeBuffer, payload]);
    } else {
      return Buffer.concat([lengthBuffer, typeBuffer]);
    }
  }

  /**
   * Envía datos por el socket
   */
  private sendData(data: Buffer): void {
    if (this.socket && this.connected) {
      this.socket.write(data);
    }
  }

  /**
   * Verifica si el peer tiene una pieza específica
   */
  hasPiece(pieceIndex: number): boolean {
    if (!this.peer.bitfield) return false;

    const byteIndex = Math.floor(pieceIndex / 8);
    const bitIndex = 7 - (pieceIndex % 8);

    if (byteIndex >= this.peer.bitfield.length) return false;

    return (this.peer.bitfield[byteIndex] & (1 << bitIndex)) !== 0;
  }

  /**
   * Desconecta del peer
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.connected = false;
    }
  }

  /**
   * Getters
   */
  isConnected(): boolean {
    return this.connected && this.handshakeCompleted;
  }

  isChoked(): boolean {
    return this.peer.choked;
  }

  getPeerInfo(): Peer {
    return this.peer;
  }

  sendKeepAlive(): void {
    const keepAliveMessage = Buffer.from([0, 0, 0, 0]); // Mensaje de keep-alive (longitud 0)
    this.sendData(keepAliveMessage);
    console.log(`💓 Keep-alive enviado a ${this.peer.ip}`);
  }

  getDownloadSpeed(): number {
    return this.downloadSpeed;
  }
}