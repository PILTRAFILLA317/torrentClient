// Tipos de mensajes del protocolo BitTorrent
export enum MessageType {
  CHOKE = 0,
  UNCHOKE = 1,
  INTERESTED = 2,
  NOT_INTERESTED = 3,
  HAVE = 4,
  BITFIELD = 5,
  REQUEST = 6,
  PIECE = 7,
  CANCEL = 8,
  PORT = 9, // DHT
}

// Estructura de un mensaje del protocolo
export interface PeerMessage {
  length: number; // Longitud del mensaje
  id?: MessageType; // Tipo de mensaje (undefined para keep-alive)
  payload?: Buffer; // Datos del mensaje
}

// Request de una pieza específica
export interface PieceRequest {
  index: number; // Índice de la pieza
  begin: number; // Offset dentro de la pieza
  length: number; // Longitud del bloque solicitado
}

// Respuesta con datos de una pieza
export interface PieceData {
  index: number; // Índice de la pieza
  begin: number; // Offset dentro de la pieza
  block: Buffer; // Datos del bloque
}