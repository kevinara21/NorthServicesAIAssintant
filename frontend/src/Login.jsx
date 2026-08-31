import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebaseConfig';
import Register from './Register';

function Login({ onLoginSuccess }) {
  const [usuarioPrefix, setUsuarioPrefix] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);
  const [modoRegistro, setModoRegistro] = useState(false);

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

      const res = await fetch('http://localhost:8000/api/perfil', {
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

  if (modoRegistro) {
    return <Register alVolverAlLogin={() => setModoRegistro(false)} />;
  }

  return (
    <div style={{ maxWidth: 380, margin: '60px auto', fontFamily: 'sans-serif' }}>
      <form onSubmit={handleLogin}>
        <h2>North Services AI Assistant</h2>
        <p style={{ color: '#555', fontSize: 14 }}>Ingreso a plataforma corporativa</p>
        
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4 }}>Usuario corporativo</label>
          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #cbd5e1', borderRadius: 4, overflow: 'hidden' }}>
            <input
              type="text"
              placeholder="ej. sergio.alvarado"
              value={usuarioPrefix}
              onChange={handleUserChange}
              required
              style={{ flex: 1, padding: 8, border: 'none', outline: 'none' }}
            />
            <span style={{ background: '#f1f5f9', padding: '8px 10px', color: '#64748b', fontSize: 13, borderLeft: '1px solid #cbd5e1', userSelect: 'none' }}>
              @northservices.com.pe
            </span>
          </div>
        </div>
        
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4 }}>Contraseña</label>
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
          />
        </div>
        
        {error && <p style={{ color: 'red', fontSize: 14 }}>{error}</p>}
        
        <button type="submit" disabled={cargando} style={{ width: '100%', padding: 10, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 'bold' }}>
          {cargando ? 'Iniciando sesión...' : 'Ingresar'}
        </button>
      </form>

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <button
          type="button"
          onClick={() => setModoRegistro(true)}
          style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, textDecoration: 'underline' }}
        >
          ¿No tienes cuenta? Solicita acceso aquí
        </button>
      </div>
    </div>
  );
}

export default Login;