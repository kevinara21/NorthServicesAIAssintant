const { db } = require('../firebaseAdmin');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No autorizado. Token no proporcionado.' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const { authAdmin } = require('../firebaseAdmin');
    const decodedToken = await authAdmin.verifyIdToken(token);
    
    // Consultar datos del usuario en Firestore
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado en la base de datos.' });
    }

    const data = userDoc.data();

    // El rol se conserva tal como lo registró o asignó el Administrador.
    // Solo se normaliza a minúsculas para poder compararlo de forma
    // consistente; NO se reemplaza por un rol por defecto, porque eso
    // hacía que una solicitud de acceso apareciera siempre como
    // "Técnico" aunque el usuario hubiera elegido otro rol.
    const rol = String(data.rol || '').trim();

    req.user = {
      uid: decodedToken.uid,
      email: data.email,
      nombre: data.nombre,
      apellido: data.apellido,
      whatsapp: data.whatsapp || '',
      whatsappVerificado: data.whatsappVerificado === true,
      // Minúsculas para comparaciones; `rolOriginal` conserva el texto exacto.
      rol: rol.toLowerCase(),
      rolOriginal: rol,
      area: data.area || data.departamento || '',
      estado: data.estado || 'pendiente'
    };

    next();
  } catch (error) {
    console.error('Error al verificar token:', error);
    return res.status(401).json({ ok: false, error: 'Token inválido o expirado.' });
  }
};

module.exports = verifyToken;