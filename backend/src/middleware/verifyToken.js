const { db } = require('../firebaseAdmin');

// Caché corta del perfil: evita leer Firestore en cada request. El TTL es bajo
// para que un cambio de rol o de estado se refleje en segundos, y el admin
// puede invalidarlo de inmediato al guardar el usuario.
const TTL_CACHE_USUARIO_MS = Number(process.env.USER_CACHE_TTL_MS || 30000);
const cacheUsuarios = new Map();

function invalidarCacheUsuario(uid) {
  if (uid) cacheUsuarios.delete(String(uid));
  else cacheUsuarios.clear();
}

function leerUsuarioCacheado(uid) {
  const entrada = cacheUsuarios.get(String(uid));
  if (!entrada) return null;
  if (Date.now() > entrada.expira) {
    cacheUsuarios.delete(String(uid));
    return null;
  }
  return entrada.datos;
}

function guardarUsuarioCacheado(uid, datos) {
  cacheUsuarios.set(String(uid), {
    datos,
    expira: Date.now() + TTL_CACHE_USUARIO_MS,
  });
  if (cacheUsuarios.size > 5000) {
    const ahora = Date.now();
    for (const [clave, entrada] of cacheUsuarios) {
      if (ahora > entrada.expira) cacheUsuarios.delete(clave);
    }
  }
}

function normalizarUsuario(uid, data) {
  const rol = String(data.rol || '').trim();
  return {
    uid,
    email: data.email,
    nombre: data.nombre,
    apellido: data.apellido,
    whatsapp: data.whatsapp || '',
    whatsappVerificado: data.whatsappVerificado === true,
    rol: rol.toLowerCase(),
    rolOriginal: rol,
    area: data.area || data.departamento || '',
    estado: data.estado || 'pendiente',
  };
}

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No autorizado. Token no proporcionado.' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const { authAdmin } = require('../firebaseAdmin');
    const decodedToken = await authAdmin.verifyIdToken(token);

    const cacheado = leerUsuarioCacheado(decodedToken.uid);
    if (cacheado) {
      req.user = cacheado;
      return next();
    }

    const userDoc = await db.collection('users').doc(decodedToken.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado en la base de datos.' });
    }

    const usuario = normalizarUsuario(decodedToken.uid, userDoc.data());
    guardarUsuarioCacheado(decodedToken.uid, usuario);
    req.user = usuario;

    next();
  } catch (error) {
    console.error('Error al verificar token:', error);
    return res.status(401).json({ ok: false, error: 'Token inválido o expirado.' });
  }
};

module.exports = verifyToken;
module.exports.invalidarCacheUsuario = invalidarCacheUsuario;
