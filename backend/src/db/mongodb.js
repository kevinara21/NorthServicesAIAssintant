const { MongoClient } = require('mongodb');
require('dotenv').config({ quiet: true });

// Pool caliente: mantener conexiones abiertas evita pagar el handshake TLS y
// la selección de servidor en cada pregunta. compressors reduce el tráfico de
// documentos grandes (vectores, inventarios) sin cambiar el esquema.
const client = new MongoClient(process.env.MONGODB_URI, {
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
  minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
  maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_MS || 60000),
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 10000),
  socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
  retryWrites: true,
  retryReads: true,
  compressors: ['zlib'],
});

let dbInstance = null;

async function connectDB() {
  if (!dbInstance) {
    try {
      await client.connect();
      dbInstance = client.db('north_services_db');
      await dbInstance.command({ ping: 1 });
      console.log('Conectado exitosamente a MongoDB Atlas');
    } catch (error) {
      console.error('Error de conexión a MongoDB Atlas:', error.message);
      process.exit(1);
    }
  }
  return dbInstance;
}

function getDB() {
  if (!dbInstance) {
    throw new Error('La base de datos MongoDB no ha sido inicializada.');
  }
  return dbInstance;
}

function getDatabase(nombre) {
  if (!dbInstance) {
    throw new Error('La base de datos MongoDB no ha sido inicializada.');
  }
  if (!['north_services_db', 'inventarios'].includes(nombre)) {
    throw new Error('Nombre de base de datos MongoDB no permitido.');
  }
  return client.db(nombre);
}

async function cerrarConexionMongo() {
  if (!dbInstance) return;
  dbInstance = null;
  await client.close();
}

module.exports = { connectDB, getDB, getDatabase, cerrarConexionMongo };
