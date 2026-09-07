// FASE 4 — Validacion de archivos de imagen (bordes de confianza del upload).
//
// El frontend valida para UX; ESTE modulo es la autoridad real (Regla del
// backend como autoridad, igual que el resto del dominio Product). Nada aqui
// confia en lo que el navegador declare (Content-Type del multipart, nombre
// de archivo): el tipo real se determina por los primeros bytes del archivo
// (magic numbers / firma de formato).
//
// SVG deliberadamente NO soportado: es XML, puede embeber <script>/manejadores
// de evento y no tiene una firma binaria fija verificable como JPEG/PNG/WEBP.
// Sanitizarlo correctamente (whitelist de tags/atributos) es una pieza de
// software en si misma y esta fuera del alcance de un catalogo de e-commerce
// que no lo necesita (las fotos de producto son siempre raster).

import multer from 'multer';

// --- Limites (documentados y aplicados en frontend Y backend) -------------
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB por archivo
export const MAX_IMAGES_PER_PRODUCT = 10;
export const MIN_IMAGE_DIMENSION_PX = 200; // evita imagenes "basura"/1x1
export const MAX_IMAGE_DIMENSION_PX = 6000; // evita fotos crudas absurdas

export const ALLOWED_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const ALLOWED_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp']);

const EXT_BY_FORMAT = { jpeg: ['.jpg', '.jpeg'], png: ['.png'], webp: ['.webp'] };

/**
 * Determina el formato REAL de una imagen a partir de sus primeros bytes
 * (firma de archivo), ignorando por completo lo que declare `Content-Type`.
 * Devuelve 'jpeg' | 'png' | 'webp' | null (formato no reconocido/soportado).
 */
export function detectImageSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIG.every((byte, i) => buffer[i] === byte)) {
    return 'png';
  }

  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

/**
 * La extension declarada del archivo (nombre del cliente) es COSMETICA
 * (el nombre de archivo es enteramente controlado por el cliente). Se exige
 * de todas formas que sea coherente con el formato real detectado, como
 * segunda linea de defensa contra un archivo "disfrazado" (p. ej. un .exe
 * renombrado a foto.png con un Content-Type falso): si ademas la extension no
 * coincide con ninguna extension valida para el formato real, se rechaza.
 */
export function extensionMatchesFormat(filename, format) {
  if (!format || !EXT_BY_FORMAT[format]) return false;
  const lower = String(filename || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = lower.slice(dot);
  return EXT_BY_FORMAT[format].includes(ext);
}

/**
 * Lee el ancho/alto de un JPEG/PNG/WEBP directamente del buffer, sin
 * dependencias externas (sharp/jimp). Suficiente para el gate de
 * dimensiones minimas/maximas — no necesitamos mas metadata que esta.
 * Devuelve `{ width, height }` o `null` si no se pudo parsear (archivo
 * corrupto/truncado): tratar `null` como invalido en el caller.
 */
export function readImageDimensions(buffer, format) {
  try {
    if (format === 'png') {
      // IHDR siempre son los primeros 25 bytes del chunk tras la firma de 8 bytes.
      if (buffer.length < 33) return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    if (format === 'jpeg') {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 llevan dimensiones.
        const isSOF =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSOF) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segmentLength;
      }
      return null;
    }

    if (format === 'webp') {
      // VP8 (lossy) / VP8L (lossless) / VP8X (extended) — los 3 formatos mas
      // comunes de Cloudinary/navegadores modernos.
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8X' && buffer.length >= 30) {
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width, height };
      }
      if (chunk === 'VP8 ' && buffer.length >= 30) {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const b = buffer.readUInt32LE(21);
        const width = (b & 0x3fff) + 1;
        const height = ((b >> 14) & 0x3fff) + 1;
        return { width, height };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// --- multer: recepcion multipart en MEMORIA (nunca a disco) ---------------
// `fileFilter` es solo un filtro RAPIDO por el Content-Type declarado del
// multipart (conveniencia/UX del error temprano); la validacion REAL
// (magic-bytes + extension + dimensiones) ocurre despues, en el controller,
// con el buffer completo ya en memoria.
export const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      const err = new Error('Tipo de archivo no permitido.');
      err.code = 'INVALID_MIME';
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * Ejecuta el middleware de multer para UN solo campo `image` de forma
 * envuelta en promesa, para poder usar try/catch simple en el controller y
 * traducir cualquier error (limite de tamano, tipo invalido, campo
 * inesperado) a un mensaje de negocio SIN exponer detalles internos.
 */
export function parseSingleImageUpload(req, res) {
  return new Promise((resolve, reject) => {
    productImageUpload.single('image')(req, res, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Traduce un error de multer/fileFilter a un mensaje de negocio claro, sin
 * stack traces ni nombres de constantes internas.
 */
export function multerErrorMessage(err) {
  if (err && err.code === 'INVALID_MIME') {
    return 'Tipo de archivo no permitido. Usa JPEG, PNG o WEBP.';
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return `El archivo supera el tamaño máximo permitido (${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB).`;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return 'Solo se admite un archivo por solicitud, en el campo "image".';
    }
    return 'No fue posible procesar el archivo enviado.';
  }
  return 'No fue posible procesar el archivo enviado.';
}
