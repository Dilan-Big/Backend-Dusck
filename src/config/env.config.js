// Carga y validacion centralizada de variables de entorno.
// Se importa una unica vez; el resto de la app consume `env` desde aqui
// en lugar de leer `process.env` disperso por el codigo.

import 'dotenv/config';

/**
 * Devuelve el valor de una variable de entorno obligatoria.
 * Si falta o esta vacia, corta el arranque con un mensaje claro
 * (sin imprimir nunca el valor).
 */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `[env] Falta la variable de entorno obligatoria: ${name}. ` +
      `Copia .env.example a .env y completa los valores locales.`
    );
  }
  return value;
}

/**
 * Devuelve el valor de una variable opcional o el valor por defecto.
 */
function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

export const env = {
  // Cadena de conexion a MongoDB (local o Atlas, segun el entorno).
  mongoUri: required('MONGO_URI'),

  // Secreto para firmar y verificar los JWT.
  jwtSecret: required('JWT_SECRET'),

  // Puerto del servidor HTTP.
  port: Number(optional('PORT', '3000')),

  // Origen permitido del frontend (para CORS en fases posteriores).
  frontendUrl: optional('FRONTEND_URL', 'http://localhost:4200'),
};

export default env;
