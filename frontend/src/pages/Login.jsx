import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import { auth } from '../services/firebaseConfig';
import Register from './Register';
import { apiFetch } from '../services/api';

function Login({ onLoginSuccess }) {
  const [usuarioPrefix, setUsuarioPrefix] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);
  const [modoRegistro, setModoRegistro] = useState(false);
  const [modoRecuperacion, setModoRecuperacion] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [recoveryPasswordVisible, setRecoveryPasswordVisible] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [nuevaPassword, setNuevaPassword] = useState('');
  const [otpEnviado, setOtpEnviado] = useState(false);

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
    setError('');
    setCargando(true);

    // Concatena siempre el dominio de forma limpia
    const emailCompleto = `${usuarioPrefix.trim()}@northservices.com.pe`;

    try {
      const userCredential = await signInWithEmailAndPassword(auth, emailCompleto, password);
      const token = await userCredential.user.getIdToken(true);

      const res = await apiFetch('/api/perfil', {
        headers: { Authorization: `Bearer ${token}` },
      });

      
      const data = await res.json();

      if (data.ok) {
        onLoginSuccess(data.usuario, token);
      } else {
        setError(data.error || 'Error al obtener el perfil de usuario');
      }
    } catch (err) {
      setError('Usuario o contraseña incorrectos');
      console.error(err);
    } finally {
      setCargando(false);
    }
  };

  const handleRecovery = async (e) => {
    e.preventDefault();
    setError('');
    setCargando(true);
    const email = `${usuarioPrefix.trim()}@northservices.com.pe`;
    try {
      const ruta = otpEnviado ? '/api/password/restablecer' : '/api/password/solicitar';
      const body = otpEnviado ? { email, codigo, nuevaPassword } : { email };
      const res = await apiFetch(ruta, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo completar la operación.');
      if (!otpEnviado) setOtpEnviado(true);
      else { setModoRecuperacion(false); setOtpEnviado(false); setCodigo(''); setNuevaPassword(''); }
      setError(otpEnviado ? 'Contraseña actualizada. Ya puedes iniciar sesión.' : 'Código enviado por WhatsApp.');
    } catch (err) { setError(err.message); }
    finally { setCargando(false); }
  };

  if (modoRegistro) {
    return <Register alVolverAlLogin={() => setModoRegistro(false)} />;
  }

  if (modoRecuperacion) {
    return (
      <div className="login-page">
        <form className="login-recovery-form" onSubmit={handleRecovery}>
          <img className="login-logo" src="/NorthServices.svg" alt="North Services" />
          <h2 className="login-heading">Recuperar contraseña</h2>
          <p className="login-subtitle">Recibirás un código por SMS en tu teléfono verificado.</p>
          <label className="login-recovery-field">Usuario corporativo<input type="text" placeholder="ej. sergio.alvarado" value={usuarioPrefix} onChange={handleUserChange} required /></label>
          {otpEnviado && <>
            <label className="login-recovery-field">Código OTP<input value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" maxLength="6" required /></label>
            <label className="login-recovery-field">Nueva contraseña<span className="password-field"><input type={recoveryPasswordVisible ? 'text' : 'password'} value={nuevaPassword} onChange={(e) => setNuevaPassword(e.target.value)} minLength="6" required /><button type="button" className="password-toggle" onClick={() => setRecoveryPasswordVisible((visible) => !visible)} aria-label={recoveryPasswordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{recoveryPasswordVisible ? <FiEyeOff /> : <FiEye />}</button></span></label>
          </>}
          {error && <p className="login-recovery-message">{error}</p>}
          <button className="login-recovery-submit" type="submit" disabled={cargando}>{cargando ? 'Procesando...' : otpEnviado ? 'Cambiar contraseña' : 'Enviar código'}</button>
        </form>
        <button className="login-secondary-link" type="button" onClick={() => { setModoRecuperacion(false); setOtpEnviado(false); setError(''); }}>Volver al inicio de sesión</button>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form onSubmit={handleLogin}>
        <img className="login-logo" src="/NorthServices.svg" alt="North Services" />
        <h2 className="login-heading" style={{ color: '#000000', marginBottom: '0.5rem' }}>AI Assistant</h2>
        <p className="login-subtitle" style={{ color: '#666666', fontSize: 14, marginBottom: '1.5rem' }}>Ingreso a plataforma corporativa</p>
        
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Usuario corporativo</label>
          <div className="login-email-field" style={{ display: 'flex', alignItems: 'center', border: '1px solid #E5E7EB', borderRadius: 4, overflow: 'hidden' }}>
            <input
              type="text"
              placeholder="ej. sergio.alvarado"
              value={usuarioPrefix}
              onChange={handleUserChange}
              required
              style={{ flex: 1, padding: 8, border: 'none', outline: 'none' }}
            />
            <span style={{ background: '#F8F9FA', padding: '8px 10px', color: '#666666', fontSize: 13, borderLeft: '1px solid #E5E7EB', userSelect: 'none' }}>
              @northservices.com.pe
            </span>
          </div>
        </div>
        
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Contraseña</label>
          <span className="password-field"><input type={passwordVisible ? 'text' : 'password'} placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }} /><button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => !visible)} aria-label={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{passwordVisible ? <FiEyeOff /> : <FiEye />}</button></span>
        </div>
        
        {error && <p style={{ color: '#DD2226', fontSize: 14, fontWeight: 600 }}>{error}</p>}
        
        <button type="submit" disabled={cargando} style={{ width: '100%', padding: 10, cursor: 'pointer', background: '#DD2226', color: '#FFFFFF', border: 'none', borderRadius: 4, fontWeight: 'bold', transition: 'all 0.3s' }}>
          {cargando ? 'Iniciando sesión...' : 'Ingresar'}
        </button>
        <button className="login-secondary-link" type="button" onClick={() => setModoRecuperacion(true)}>¿Olvidaste tu contraseña?</button>
      </form>

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <button
          type="button"
          onClick={() => setModoRegistro(true)}
          className="login-secondary-link"
        >
          ¿No tienes cuenta? Solicita acceso aquí
        </button>
      </div>
    </div>
  );
}

export default Login;