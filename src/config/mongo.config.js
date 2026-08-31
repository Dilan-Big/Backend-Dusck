import mongoose from 'mongoose';

import { env } from './env.config.js';

// Oculta credenciales (usuario:contraseña) al mostrar el host de destino en logs.
function safeMongoTarget(uri) {
  try {
    const { protocol, host, pathname } = new URL(uri);
    return `${protocol}//${host}${pathname}`;
  } catch {
    return 'destino desconocido';
  }
}

// Elimina cualquier "usuario:pass@" y URIs completas que un mensaje de error
// pudiera llegar a incluir, para no filtrar credenciales en consola.
function redact(text) {
  return String(text)
    .replace(/mongodb(\+srv)?:\/\/[^\s]*/gi, '[REDACTED_URI]')
    .replace(/\/\/[^/@\s]+@/g, '//[REDACTED]@');
}

async function dbConection() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log(`Connected to MongoDB (${safeMongoTarget(env.mongoUri)})`);
  } catch (error) {
    // No imprimimos `error` crudo para evitar filtrar la URI con credenciales.
    console.error(`Connect Failed! :'( -> ${error.name}: ${redact(error.message)}`);
    process.exit(1);
  }
}

export default dbConection;
