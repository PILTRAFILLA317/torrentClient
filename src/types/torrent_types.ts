// Estructura de un archivo .torrent decodificado
export interface TorrentFile {
  announce: string; // URL del tracker principal
  'announce-list'?: string[][]; // Lista de trackers alternativos
  info: TorrentInfo;
  'creation date'?: number;
  comment?: string;
  'created by'?: string;
}

// Información principal del torrent
export interface TorrentInfo {
  name: string; // Nombre del archivo/directorio
  'piece length': number; // Tamaño de cada pieza en bytes
  pieces: Buffer; // Hash SHA1 de cada pieza (20 bytes por pieza)
  length?: number; // Tamaño total (para archivos únicos)
  files?: FileInfo[]; // Lista de archivos (para torrents multi-archivo)
  private?: number; // 1 si es privado
}

// Información de archivos individuales (torrents multi-archivo)
export interface FileInfo {
  length: number; // Tamaño del archivo
  path: string[]; // Ruta del archivo como array
}

// Metadatos procesados del torrent
export interface TorrentMetadata {
  infoHash: Buffer; // Hash SHA1 del diccionario 'info'
  pieceHashes: Buffer[]; // Array de hashes individuales de cada pieza
  totalLength: number; // Tamaño total de todos los archivos
  pieceCount: number; // Número total de piezas
  pieceLength: number;
  fileName: string; // Nombre del archivo principal
  announceList: string[]; // Lista plana de todos los trackers
}