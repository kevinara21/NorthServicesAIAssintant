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

    req.user = {
      uid: decodedToken.uid,
      email: data.email,
      nombre: data.nombre,
      apellido: data.apellido,
      whatsapp: data.whatsapp || '',
      whatsappVerificado: data.whatsappVerificado === true,
      // Convertir siempre a minúsculas para comparaciones consistentes
      rol: (data.rol || 'tecnico').toLowerCase(),
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