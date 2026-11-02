import { useState } from 'react';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import { auth } from '../services/firebaseConfig';
import Register from './Register';
import { apiFetch, apiJson } from '../services/api';
import { useNotification } from '../context/NotificationContext';
import useCountdown, { formatearSegundos } from '../hooks/useCountdown';

const OTP_DIARIO = 5;

function Login({ onLoginSuccess }) {
  const [usuarioPrefix, setUsuarioPrefix] = useState('');
  const [password, setPassword] = useState('');
  const [cargando, setCargando] = useState(false);

  // 'login' | 'registro' | 'recuperacion'
  const [vista, setVista] = useState('login');
  const [direccion, setDireccion] = useState('forward');
  const [animando, setAnimando] = useState(false);

  const [passwordVisible, setPasswordVisible] = useState(false);
  const [recoveryPasswordVisible, setRecoveryPasswordVisible] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [nuevaPassword, setNuevaPassword] = useState('');
  const [otpEnviado, setOtpEnviado] = useState(false);
  const [canal, setCanal] = useState('correo');
  const [restanteHoy, setRestanteHoy] = useState(null);

  const { notificarExito, notificarError, notificarAdvertencia, notificarInfo } = useNotification();

  const { restante: espera, iniciar: iniciarEspera } = useCountdown(
    `otp:restablecer-password:${usuarioPrefix.trim().toLowerCase() || 'anonimo'}`
  );

  // Transición fluida con continuidad entre vistas
  const cambiarVista = (nuevaVista) => {
    if (nuevaVista === vista || animando) return;
    const esHaciaAdelante = nuevaVista === 'registro' || (vista === 'login' && nuevaVista === 'recuperacion');
    setDireccion(esHaciaAdelante ? 'forward' : 'backward');
    setAnimando(true);
    setTimeout(() => {
      setVista(nuevaVista);
      setTimeout(() => {
        setAnimando(false);
      }, 30);
    }, 150);
  };

  // Limpia el texto eliminando @ y cualquier dominio que intenten escribir
  const handleUserChange = (e) => {
    const valorLimpio = e.target.value
      .toLowerCase()
      .split('@')[0] // Corta todo a partir de la arroba
      .replace(/\s+/g, ''); // Elimina espacios en blanco

    setUsuarioPrefix(valorLimpio);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setCargando(true);

    // Concatena siempre el dominio de forma limpia
    const emailCompleto = `${usuarioPrefix.trim()}@northservices.com.pe`;

    try {
      const userCredential = await signInWithEmailAndPassword(auth, emailCompleto, password);
      const token = await userCredential.user.getIdToken(true);

      const res = await apiFetch('/api/perfil', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json().catch(() => ({}));

      // Validar respuesta del servidor y estado activo
      if (res.ok && data.ok && data.usuario?.estado === 'activo') {
        notificarExito(`¡Bienvenid@, ${data.usuario.nombre || 'usuario'}!`, {
          titulo: 'Sesión iniciada',
          duracion: 3500,
        });
        onLoginSuccess(data.usuario, token);
      } else {
        // Cerrar sesión de Firebase de inmediato para que no quede abierta
        await signOut(auth);

        const mensajeBloqueo = data.error || (data.estado === 'pendiente' || !res.ok
          ? 'El administrador aún no ha habilitado su cuenta para el sistema.'
          : 'Su cuenta no se encuentra activa en el sistema. Contacte al administrador.');

        notificarAdvertencia(mensajeBloqueo, {
          titulo: 'Acceso No Habilitado',
          duracion: 6500,
        });
      }
    } catch (err) {
      console.error('Error al iniciar sesión:', err);
      let mensajeError = 'Usuario o contraseña incorrectos';
      if (err.code === 'auth/too-many-requests') {
        mensajeError = 'Demasiados intentos fallidos. Intenta más tarde.';
      } else if (err.code === 'auth/network-request-failed') {
        mensajeError = 'Error de conexión con el servidor. Revisa tu conexión a internet.';
      }

      notificarError(mensajeError, {
        titulo: 'Error de Autenticación',
      });
    } finally {
      setCargando(false);
    }
  };

  const solicitarCodigo = async () => {
    if (espera > 0) return;
    setCargando(true);
    const email = `${usuarioPrefix.trim()}@northservices.com.pe`;
    try {
      const data = await apiJson('/api/password/solicitar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, canal }),
      });
      setOtpEnviado(true);
      iniciarEspera(data.reintentarEn || 120);
      if (typeof data.restanteHoy === 'number') setRestanteHoy(data.restanteHoy);
      notificarInfo(
        canal === 'correo'
          ? 'Código de verificación enviado a tu correo corporativo.'
          : 'Código de verificación enviado por SMS.',
        { titulo: 'Código OTP' }
      );
    } catch (err) {
      if (err.reintentarEn) iniciarEspera(err.reintentarEn);
      if (typeof err.restanteHoy === 'number') setRestanteHoy(err.restanteHoy);
      notificarError(err.message, { titulo: 'No se pudo enviar el código' });
    } finally {
      setCargando(false);
    }
  };

  const handleRecovery = async (e) => {
    e.preventDefault();
    if (!otpEnviado) {
      await solicitarCodigo();
      return;
    }

    setCargando(true);
    const email = `${usuarioPrefix.trim()}@northservices.com.pe`;
    try {
      await apiJson('/api/password/restablecer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, codigo, nuevaPassword }),
      });

      setOtpEnviado(false);
      setCodigo('');
      setNuevaPassword('');
      notificarExito('Contraseña actualizada con éxito. Ya puedes iniciar sesión con tus nuevas credenciales.', {
        titulo: 'Contraseña restablecida',
        duracion: 6000,
      });
      cambiarVista('login');
    } catch (err) {
      notificarError(err.message, { titulo: 'Error al recuperar' });
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="auth-viewport">
      <div className="auth-viewport-grid" aria-hidden="true" />
      <div className="auth-viewport-watermark" aria-hidden="true" />

      <div className={`auth-card auth-card-${vista}`}>
        {/* Encabezado corporativo persistente y unificado */}
        <div className="auth-header">
          <img className="auth-logo" src="/NorthServices.svg" alt="North Services" />
          {vista === 'login' && <h1 className="auth-heading">AI Assistant</h1>}
          {vista === 'registro' && (
            <>
              <h1 className="auth-heading">Solicitud de Acceso</h1>
              <p className="auth-subtitle">North Services AI Assistant</p>
            </>
          )}
          {vista === 'recuperacion' && <h1 className="auth-heading">Recuperar contraseña</h1>}
        </div>

        {/* Contenido con transición direccional suave */}
        <div
          className={`auth-view-content ${
            animando
              ? direccion === 'forward'
                ? 'auth-view-exit-forward'
                : 'auth-view-exit-backward'
              : direccion === 'forward'
              ? 'auth-view-enter-forward'
              : 'auth-view-enter-backward'
          }`}
        >
          {vista === 'login' && (
            <>
              <form className="auth-form" onSubmit={handleLogin}>
                <div className="auth-field">
                  <label className="auth-label" htmlFor="login-usuario">
                    Usuario corporativo
                  </label>
                  <div className="auth-input-suffix-group">
                    <input
                      id="login-usuario"
                      type="text"
                      placeholder="ej. nombre.apellido"
                      value={usuarioPrefix}
                      onChange={handleUserChange}
                      required
                      autoComplete="username"
                    />
                    <span className="auth-input-domain">@northservices.com.pe</span>
                  </div>
                </div>

                <div className="auth-field">
                  <label className="auth-label" htmlFor="login-password">
                    Contraseña
                  </label>
                  <div className="auth-password-group">
                    <input
                      id="login-password"
                      className="auth-input"
                      type={passwordVisible ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
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

                <button
                  className="auth-btn-primary"
                  type="submit"
                  disabled={cargando}
                >
                  {cargando && <span className="auth-btn-spinner" aria-hidden="true" />}
                  <span>{cargando ? 'Iniciando sesión...' : 'Ingresar'}</span>
                </button>

                <div style={{ textAlign: 'center', marginTop: 3 }}>
                  <button
                    className="auth-link-forgot"
                    type="button"
                    onClick={() => cambiarVista('recuperacion')}
                  >
                    ¿Olvidaste tu contraseña?
                  </button>
                </div>
              </form>

              <div className="auth-footer">
                <button
                  type="button"
                  onClick={() => cambiarVista('registro')}
                  className="auth-switch-btn"
                >
                  ¿No tienes cuenta? <span className="auth-switch-highlight">Solicita acceso aquí</span>
                </button>
              </div>
            </>
          )}

          {vista === 'registro' && (
            <Register
              alVolverAlLogin={() => cambiarVista('login')}
              dentroDeAuthCard={true}
            />
          )}

          {vista === 'recuperacion' && (
            <>
              <form className="auth-form" onSubmit={handleRecovery}>
                <div className="auth-channel-selector" role="radiogroup" aria-label="Cómo recibir el código">
                  <div
                    className={`auth-channel-indicator ${canal === 'sms' ? 'slide-sms' : 'slide-correo'}`}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className={`auth-channel-option ${canal === 'correo' ? 'active' : ''}`}
                    onClick={() => setCanal('correo')}
                    role="radio"
                    aria-checked={canal === 'correo'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-10 6L2 7" />
                    </svg>
                    <span>Correo corporativo</span>
                  </button>
                  <button
                    type="button"
                    className={`auth-channel-option ${canal === 'sms' ? 'active' : ''}`}
                    onClick={() => setCanal('sms')}
                    role="radio"
                    aria-checked={canal === 'sms'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="7" y="2" width="10" height="20" rx="2" />
                      <path d="M11 18.5h2" />
                    </svg>
                    <span>SMS</span>
                  </button>
                </div>

                <div className="auth-field">
                  <label className="auth-label" htmlFor="recovery-usuario">
                    Usuario corporativo
                  </label>
                  <div className="auth-input-suffix-group">
                    <input
                      id="recovery-usuario"
                      type="text"
                      placeholder="ej. nombre.apellido"
                      value={usuarioPrefix}
                      onChange={handleUserChange}
                      required
                    />
                    <span className="auth-input-domain">@northservices.com.pe</span>
                  </div>
                </div>

                {otpEnviado && (
                  <>
                    <div className="auth-field">
                      <label className="auth-label" htmlFor="recovery-codigo">
                        Código OTP
                      </label>
                      <input
                        id="recovery-codigo"
                        className="auth-input"
                        value={codigo}
                        onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        required
                      />
                    </div>

                    <div className="auth-field">
                      <label className="auth-label" htmlFor="recovery-password">
                        Nueva contraseña
                      </label>
                      <div className="auth-password-group">
                        <input
                          id="recovery-password"
                          className="auth-input"
                          type={recoveryPasswordVisible ? 'text' : 'password'}
                          value={nuevaPassword}
                          onChange={(e) => setNuevaPassword(e.target.value)}
                          minLength={6}
                          required
                        />
                        <button
                          type="button"
                          className="auth-password-toggle"
                          onClick={() => setRecoveryPasswordVisible((visible) => !visible)}
                          aria-label={recoveryPasswordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                        >
                          {recoveryPasswordVisible ? <FiEyeOff /> : <FiEye />}
                        </button>
                      </div>
                    </div>

                    <div style={{ textAlign: 'center', marginTop: 4 }}>
                      <button
                        type="button"
                        className="auth-link-forgot"
                        onClick={solicitarCodigo}
                        disabled={cargando || espera > 0}
                      >
                        {espera > 0
                          ? `Reenviar código en ${formatearSegundos(espera)}`
                          : 'Reenviar código'}
                      </button>
                      {typeof restanteHoy === 'number' && (
                        <p style={{ margin: '4px 0 0', fontSize: '0.78rem', opacity: 0.75 }}>
                          Códigos restantes hoy: {restanteHoy} de {OTP_DIARIO}.
                        </p>
                      )}
                    </div>
                  </>
                )}

                <button
                  className="auth-btn-primary"
                  type="submit"
                  disabled={cargando || (!otpEnviado && espera > 0)}
                >
                  {cargando && <span className="auth-btn-spinner" aria-hidden="true" />}
                  <span>
                    {cargando
                      ? 'Procesando...'
                      : otpEnviado
                        ? 'Cambiar contraseña'
                        : espera > 0
                          ? `Reenviar en ${formatearSegundos(espera)}`
                          : 'Enviar código'}
                  </span>
                </button>
              </form>

              <div className="auth-footer">
                <button
                  className="auth-switch-btn"
                  type="button"
                  onClick={() => {
                    setOtpEnviado(false);
                    cambiarVista('login');
                  }}
                >
                  Volver al inicio de sesión
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default Login;