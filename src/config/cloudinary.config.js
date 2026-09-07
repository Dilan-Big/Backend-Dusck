// FASE 4 — Configuracion de Cloudinary (almacenamiento de imagenes de producto).
//
// Arquitectura elegida: UPLOAD INTERMEDIADO POR BACKEND (nunca upload firmado
// directo desde Angular). Justificacion completa en el reporte de F4; resumen:
//   - el backend YA es la unica autoridad de autorizacion del dominio Product
//     (ownership + estado editable, ver `productWorkflow.helper.js`) — un
//     upload firmado movería esa autoridad a un token de firma que no puede
//     revalidar ownership/estado en el momento exacto del upload;
//   - `CLOUDINARY_API_SECRET` nunca sale de este proceso;
//   - permite sniff de magic-bytes, limites de tamano/cantidad y cleanup de
//     huerfanos en un unico punto controlado.
//
// `CLOUDINARY_API_SECRET` NUNCA se expone: ni al frontend, ni en logs, ni en
// respuestas HTTP, ni en mensajes de error (ver `assertCloudinaryConfigured`).

import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.config.js';

let configured = false;

function configureOnce() {
  if (configured) return;
  const { cloudName, apiKey, apiSecret } = env.cloudinary;
  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
  }
  configured = true;
}

configureOnce();

/**
 * true si las tres credenciales de Cloudinary estan presentes. NO valida que
 * sean correctas (eso solo lo confirma la primera llamada real a la API).
 */
export function isCloudinaryConfigured() {
  const { cloudName, apiKey, apiSecret } = env.cloudinary;
  return !!(cloudName && apiKey && apiSecret);
}

/**
 * Corta temprano, con un error controlado (nunca una excepcion cruda de la
 * SDK con detalles internos), si Cloudinary no esta configurado en este
 * entorno. Los controllers de imagenes SIEMPRE llaman esto antes de tocar la
 * SDK, para responder 500 con un mensaje generico en vez de fallar de forma
 * impredecible dentro de `cloudinary.uploader.*`.
 */
export function assertCloudinaryConfigured() {
  if (!isCloudinaryConfigured()) {
    const err = new Error('El servicio de imagenes no esta configurado');
    err.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw err;
  }
}

export { cloudinary };
export default cloudinary;
