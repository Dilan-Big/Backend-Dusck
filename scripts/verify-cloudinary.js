/**
 * FASE 4-CLOSURE — Validación operacional de Cloudinary REAL.
 *
 * Este script NO se puede correr en la sesión de implementación: no hay
 * credenciales de Cloudinary disponibles en este entorno (`.env` sin
 * CLOUDINARY_*), y nunca se le piden secretos al usuario por chat. Queda
 * aquí para que, quien tenga acceso a la cuenta de Cloudinary del proyecto,
 * pueda ejecutar UNA validación real y desechable contra la API real:
 *
 *   1. rellena CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET en tu `.env`
 *      local (ver `.env.example`);
 *   2. node scripts/verify-cloudinary.js
 *
 * Qué hace: sube una imagen PNG mínima pero VÁLIDA (renderizable de
 * verdad — no una fixture sintética de test) generada en memoria, verifica
 * que Cloudinary devuelva URL/publicId/dimensiones coherentes, y borra el
 * asset inmediatamente después (no deja basura en la cuenta). No imprime
 * NINGÚN secreto. Termina con exit code 0 (éxito) o 1 (fallo), con un
 * resumen legible.
 *
 * NO requiere MongoDB ni el servidor HTTP levantado: llama directamente a
 * `cloudinaryImageService`, el mismo módulo que usa el backend real.
 */

import zlib from 'node:zlib';

import { isCloudinaryConfigured } from '../src/config/cloudinary.config.js';
import { cloudinaryImageService } from '../src/services/cloudinaryImage.service.js';

// --- Genera un PNG 200x200 RGB solido, REAL y valido (firma + IHDR + IDAT
// comprimido con zlib + CRC32 correcto en cada chunk) — no es una fixture de
// test con bytes a medias: Cloudinary lo decodifica de verdad. ------------
function buildRealPng(width = 200, height = 200, rgb = [220, 38, 38]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }
  const idatData = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  console.log('=== F4-CLOSURE — Validación operacional de Cloudinary REAL ===\n');

  if (!isCloudinaryConfigured()) {
    console.error(
      'CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET no están configurados en tu .env.\n' +
        'Rellénalos (ver .env.example) y vuelve a ejecutar este script.',
    );
    process.exitCode = 1;
    return;
  }

  const png = buildRealPng();
  console.log(`Imagen de prueba generada: PNG real 200x200 (${png.length} bytes).`);

  let uploaded;
  try {
    console.log('Subiendo a Cloudinary...');
    uploaded = await cloudinaryImageService.upload(png, 'verify-cloudinary-script');
  } catch (err) {
    console.error(`FALLÓ el upload real: ${err && err.name} ${err && err.message ? '(mensaje omitido por seguridad si contiene detalle de credenciales)' : ''}`);
    process.exitCode = 1;
    return;
  }

  const problems = [];
  if (!uploaded.url || !uploaded.url.startsWith('https://')) problems.push('la URL devuelta no es una https:// válida');
  if (!uploaded.publicId) problems.push('no se recibió publicId');
  if (uploaded.width !== 200 || uploaded.height !== 200) {
    problems.push(`dimensiones inesperadas: ${uploaded.width}x${uploaded.height} (se esperaba 200x200)`);
  }

  console.log(`  url: ${uploaded.url}`);
  console.log(`  publicId: ${uploaded.publicId}`);
  console.log(`  dimensiones: ${uploaded.width}x${uploaded.height}`);

  console.log('\nBorrando el asset de prueba (cleanup)...');
  const destroyed = await cloudinaryImageService.destroy(uploaded.publicId);
  if (!destroyed) problems.push('el borrado de limpieza no se confirmó (revisar manualmente en el dashboard de Cloudinary)');
  console.log(`  destroy() -> ${destroyed ? 'OK' : 'NO CONFIRMADO'}`);

  console.log('\n=== Resultado ===');
  if (problems.length === 0) {
    console.log('PASS — upload real + destroy real funcionan correctamente contra la cuenta configurada.');
  } else {
    console.log('FAIL — se detectaron problemas:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error inesperado ejecutando la validación:', err && err.name);
  process.exitCode = 1;
});
