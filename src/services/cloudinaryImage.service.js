// FASE 4 — Envoltorio del SDK de Cloudinary para imagenes de producto.
//
// Deliberadamente un OBJETO con metodos (no funciones sueltas exportadas):
// el mismo patron que ya usa esta base de codigo para poder stubear
// dependencias externas en tests (`t.mock.method(ProductModel, ...)` en
// order-service.test.js / product-inventory-ops.test.js). Los tests de F4
// stubean `cloudinaryImageService.upload` / `.destroy` para cubrir
// exito/fallo/timeout de Cloudinary SIN red real ni credenciales reales.
//
// `destroy` NUNCA lanza: es siempre "best effort" (cleanup de huerfanos), y
// que falle no debe tumbar la request que lo dispara (ver orphan handling en
// `product.services.js`).

import { cloudinary, assertCloudinaryConfigured } from '../config/cloudinary.config.js';
import { env } from '../config/env.config.js';

export const cloudinaryImageService = {
  /**
   * Sube un buffer ya validado (tipo/tamaño/firma) a Cloudinary.
   * Devuelve `{ url, publicId, width, height }` en exito.
   * Lanza en fallo (red/timeout/credenciales/rechazo) — el caller decide la
   * respuesta HTTP; el mensaje de este error NUNCA se reenvia tal cual al
   * cliente (podria traer detalle de la SDK).
   */
  async upload(buffer, folderSuffix) {
    assertCloudinaryConfigured();
    const folder = folderSuffix
      ? `${env.cloudinary.uploadFolder}/${folderSuffix}`
      : env.cloudinary.uploadFolder;

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          quality: 'auto',
          fetch_format: 'auto',
        },
        (error, result) => {
          if (error || !result) {
            return reject(error || new Error('Cloudinary no devolvió un resultado válido'));
          }
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
          });
        },
      );
      stream.end(buffer);
    });
  },

  /**
   * Borra un asset por su publicId. Best-effort: nunca lanza. Devuelve
   * `true` si Cloudinary confirmó el borrado, `false` en cualquier otro caso
   * (incluido "no configurado" o error de red) — el caller solo lo usa para
   * logging/telemetría, nunca para decidir si la operación de negocio (borrar
   * la imagen del producto) tuvo éxito.
   */
  async destroy(publicId) {
    if (!publicId) return false;
    try {
      assertCloudinaryConfigured();
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      return result?.result === 'ok' || result?.result === 'not found';
    } catch (error) {
      console.error(`cloudinaryImageService.destroy(${publicId}) -> ${error && error.name}`);
      return false;
    }
  },
};

export default cloudinaryImageService;
