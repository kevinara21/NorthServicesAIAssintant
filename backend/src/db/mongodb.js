const { MongoClient } = require('mongodb');
require('dotenv').config();

const client = new MongoClient(process.env.MONGODB_URI);
let dbInstance = null;

async function connectDB() {
  if (!dbInstance) {
    try {
      await client.connect();
      console.log('Conectado exitosamente a MongoDB Atlas');
      dbInstance = client.db('north_services_db');
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
  if (!['north_services_db', 'mwd', 'motores'].includes(nombre)) {
    throw new Error('Nombre de base de datos MongoDB no permitido.');
  }
  return client.db(nombre);
}

module.exports = { connectDB, getDB, getDatabase };