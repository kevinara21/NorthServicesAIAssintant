import { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';

function App() {
  const [usuario, setUsuario] = useState(null);
  const [token, setToken] = useState(null);
  const [cargando, setCargando] = useState(true);

  // Recuperar sesión persistente si el navegador se recarga
  useEffect(() => {
    const sesionGuardada = localStorage.getItem('sesion_north_ai');
    if (sesionGuardada) {
      const { usuarioData, tokenData } = JSON.parse(sesionGuardada);
      setUsuario(usuarioData);
      setToken(tokenData);
    }
    setCargando(false);
  }, []);

  const handleLoginSuccess = (usuarioData, tokenData) => {
    setUsuario(usuarioData);
    setToken(tokenData);
    localStorage.setItem('sesion_north_ai', JSON.stringify({ usuarioData, tokenData }));
  };

  const handleLogout = () => {
    setUsuario(null);
    setToken(null);
    localStorage.removeItem('sesion_north_ai');
  };

  if (cargando) return <div style={{ padding: 20 }}>Cargando sistema...</div>;

  return (
    <div>
      {!usuario ? (
        <Login onLoginSuccess={handleLoginSuccess} />
      ) : (
        <Dashboard usuario={usuario} token={token} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;