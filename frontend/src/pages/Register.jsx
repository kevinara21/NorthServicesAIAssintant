import React, { useState, useEffect } from 'react';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../services/firebaseConfig';
import { useNotification } from '../context/NotificationContext';

export default function Register({ alVolverAlLogin, dentroDeAuthCard = false }) {
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [whatsapp, setWhatsapp] = useState('');

  const [areaSeleccionada, setAreaSeleccionada] = useState('');
  const [otraArea, setOtraArea] = useState('');

  // El rol NO tiene valor por defecto: se guarda exactamente el que el
  // usuario elija. Si se iniciara en "Técnico", toda solicitud enviada
  // sin tocar el selector llegaría al Administrador como "Técnico".
  const [rolSeleccionado, setRolSeleccionado] = useState('');
  const [otroRol, setOtroRol] = useState('');

  const [cargando, setCargando] = useState(false);

  const { notificarExito, notificarError, notificarAdvertencia } = useNotification();

  const [areasExistentes, setAreasExistentes] = useState([]);
  const [rolesExistentes, setRolesExistentes] = useState([]);

  useEffect(() => {
    // Roles y áreas se leen del backend (derivados de los usuarios
    // registrados), no de una lista fija en el frontend.
    fetch('/api/roles')
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.roles)) {
          setRolesExistentes(data.roles.map((item) => String(item).trim()).filter(Boolean));
        }
      })
      .catch(() => {});
    fetch('/api/areas')
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.areas)) {
          setAreasExistentes(data.areas.map((item) => String(item).trim()).filter(Boolean));
        }
      })
      .catch(() => {});
  }, []);

  const emailGenerado = (nombre && apellido) 
    ? `${nombre.trim().toLowerCase()}.${apellido.trim().toLowerCase()}@northservices.com.pe` 
    : '';

  const manejarRegistro = async (e) => {
    e.preventDefault();
    setCargando(true);

    const areaFinal = areaSeleccionada === 'Crear nueva área...' ? otraArea.trim() : areaSeleccionada;
    const rolFinal = rolSeleccionado === 'Crear nuevo rol...' ? otroRol.trim() : rolSeleccionado;

    if (!areaFinal) {
      const msg = 'Por favor seleccione o cree un Área.';
      notificarAdvertencia(msg, { titulo: 'Campos requeridos' });
      setCargando(false);
      return;
    }

    // El rol debe venir siempre de una elección explícita del usuario: es
    // lo que el Administrador verá como "Rol solicitado".
    if (!rolFinal || rolFinal === 'Crear nuevo rol...') {
      const msg = 'Por favor seleccione un Rol para tu solicitud.';
      notificarAdvertencia(msg, { titulo: 'Campos requeridos' });
      setCargando(false);
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, emailGenerado, password);
      const user = userCredential.user;

      await setDoc(doc(db, 'users', user.uid), {
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        email: emailGenerado,
        rol: rolFinal,
        area: areaFinal,
        estado: 'pendiente',
        fechaRegistro: new Date(),
        ...(whatsapp.trim() ? { whatsapp: whatsapp.trim(), whatsappVerificado: false } : {}),
      });

      // Asegurar que el usuario recién creado no quede autenticado
      await signOut(auth);

      const mensajeExito = 'Solicitud enviada exitosamente. Tu cuenta se encuentra en revisión por el administrador.';

      notificarExito(mensajeExito, {
        titulo: 'Solicitud Enviada',
        duracion: 7000,
      });
    } catch (error) {
      console.error('Error al registrar usuario:', error);
      let errorTexto = 'Ocurrió un error al registrar la cuenta.';
      if (error.code === 'auth/email-already-in-use') {
        errorTexto = 'El correo corporativo generado ya se encuentra registrado.';
      } else if (error.code === 'auth/weak-password') {
        errorTexto = 'La contraseña debe tener al menos 6 caracteres.';
      }
      notificarError(errorTexto, { titulo: 'Error de Registro' });
    } finally {
      setCargando(false);
    }
  };

  const contenidoRegistro = (
    <>
      {!dentroDeAuthCard && (
        <div className="auth-header">
          <img className="auth-logo" src="/NorthServices.svg" alt="North Services" />
          <h1 className="auth-heading">Solicitud de Acceso</h1>
          <p className="auth-subtitle">North Services AI Assistant</p>
        </div>
      )}

      <form className="auth-form" onSubmit={manejarRegistro}>
        {/* Fila 1: Nombre y Apellido */}
        <div className="auth-grid-2">
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-nombre">Nombre</label>
            <input
              id="register-nombre"
              className="auth-input"
              type="text"
              placeholder="Nombre"
              value={nombre}
              onChange={(e) => setNombre(e.target.value.replace(/\s+/g, ''))}
              required
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="register-apellido">Apellido</label>
            <input
              id="register-apellido"
              className="auth-input"
              type="text"
              placeholder="Apellido"
              value={apellido}
              onChange={(e) => setApellido(e.target.value.replace(/\s+/g, ''))}
              required
            />
          </div>
        </div>

        {/* Fila 2: Correo autogenerado */}
        <div className="auth-field">
          <label className="auth-label" htmlFor="register-email">Correo autogenerado</label>
          <div className="auth-input-readonly-group">
            <input
              id="register-email"
              className="auth-input auth-input-readonly"
              type="email"
              value={emailGenerado}
              readOnly
              placeholder="nombre.apellido@northservices.com.pe"
            />
            {emailGenerado && (
              <span className="auth-input-readonly-tag" aria-hidden="true">
                Automático
              </span>
            )}
          </div>
        </div>

        {/* Fila 3: Contraseña y WhatsApp */}
        <div className="auth-grid-2">
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-password">Contraseña</label>
            <div className="auth-password-group">
              <input
                id="register-password"
                className="auth-input"
                type={passwordVisible ? 'text' : 'password'}
                placeholder="Mínimo 6 caracteres"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setPasswordVisible((visible) => !visible)}
                aria-label={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {passwordVisible ? <FiEyeOff /> : <FiEye />}
              </button>
            </div>
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="register-whatsapp">WhatsApp (opcional)</label>
            <input
              id="register-whatsapp"
              className="auth-input"
              type="tel"
              placeholder="+51987654321"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
            />
            <span className="auth-hint">Podrás verificarlo desde tu perfil.</span>
          </div>
        </div>

        {/* Fila 4: Área y Rol */}
        <div className="auth-grid-2">
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-area">Área</label>
            <select
              id="register-area"
              className="auth-select"
              value={areaSeleccionada}
              onChange={(e) => setAreaSeleccionada(e.target.value)}
              required
            >
              <option value="">Selecciona un área…</option>
              {areasExistentes.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
              <option value="Crear nueva área...">+ Crear nueva área…</option>
            </select>
            {areaSeleccionada === 'Crear nueva área...' && (
              <input
                type="text"
                className="auth-input auth-field-extra"
                placeholder="Escriba el nombre de la nueva área"
                value={otraArea}
                onChange={(e) => setOtraArea(e.target.value)}
                required
              />
            )}
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="register-rol">Rol</label>
            <select
              id="register-rol"
              className="auth-select"
              value={rolSeleccionado}
              onChange={(e) => setRolSeleccionado(e.target.value)}
              required
            >
              <option value="">Selecciona un rol…</option>
              {rolesExistentes.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
              <option value="Crear nuevo rol...">+ Crear nuevo rol…</option>
            </select>
            {rolSeleccionado === 'Crear nuevo rol...' && (
              <input
                type="text"
                className="auth-input auth-field-extra"
                placeholder="Escriba el nombre del nuevo rol"
                value={otroRol}
                onChange={(e) => setOtroRol(e.target.value)}
                required
              />
            )}
          </div>
        </div>

        <button
          className="auth-btn-primary"
          type="submit"
          disabled={cargando}
        >
          {cargando && <span className="auth-btn-spinner" aria-hidden="true" />}
          <span>{cargando ? 'Enviando...' : 'Registrar'}</span>
        </button>
      </form>

      <div className="auth-footer">
        <button
          type="button"
          onClick={alVolverAlLogin}
          className="auth-switch-btn"
        >
          ¿Ya tienes cuenta? <span className="auth-switch-highlight">Inicia sesión aquí</span>
        </button>
      </div>
    </>
  );

  if (dentroDeAuthCard) {
    return contenidoRegistro;
  }

  return (
    <div className="auth-viewport">
      <div className="auth-viewport-grid" aria-hidden="true" />
      <div className="auth-viewport-watermark" aria-hidden="true" />
      <div className="auth-card auth-card-registro">
        {contenidoRegistro}
      </div>
    </div>
  );
}