// Respuesta del tracker HTTP/HTTPS
export interface TrackerResponse {
  interval: number; // Tiempo en segundos entre requests
  'min interval'?: number; // Intervalo mínimo
  'tracker id'?: string; // ID del tracker
  complete: number; // Número de seeders
  incomplete: number; // Número de leechers
  peers: Buffer | PeerInfo[]; // Lista de peers (compact o expanded)
  'failure reason'?: string; // Razón de fallo si existe
  'warning message'?: string; // Mensaje de advertencia
}

// Información de un peer individual
export interface PeerInfo {
  'peer id': string; // ID del peer
  ip: string; // Dirección IP
  port: number; // Puerto
}

// Peer procesado para uso interno
export interface Peer {
  id: Buffer; // ID del peer (20 bytes)
  ip: string;
  port: number;
  socket?: any; // Socket TCP cuando esté conectado
  choked: boolean; // Si estamos choked por este peer
  interested: boolean; // Si estamos interesados en este peer
  choking: boolean; // Si estamos choking a este peer
  peerInterested: boolean; // Si el peer está interesado en nosotros
  bitfield?: Buffer; // Bitfield de piezas que tiene el peer
}