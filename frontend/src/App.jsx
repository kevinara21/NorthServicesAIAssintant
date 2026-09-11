import { useState, useEffect, useCallback } from 'react';
import { NotificationProvider, useNotification } from './context/NotificationContext';
import Login from './pages/Login';
import Dashboard from './components/Dashboard';
import { apiFetch } from './services/api';

function AppContent() {
  const [usuario, setUsuario] = useState(null);
  const [token, setToken] = useState(null);
  const [cargando, setCargando] = useState(true);
  const { notificarAdvertencia } = useNotification();

  const handleLogout = useCallback(() => {
    setUsuario(null);
    setToken(null);
    localStorage.removeItem('sesion_north_ai');
  }, []);

  const handleLoginSuccess = useCallback((usuarioData, tokenData) => {
    // Solo permitir login si el usuario está activo
    if (usuarioData?.estado !== 'activo') {
      handleLogout();
      notificarAdvertencia('El administrador aún no ha habilitado su cuenta para el sistema.', {
        titulo: 'Acceso Denegado',
        duracion: 6000,
      });
      return;
    }

    setUsuario(usuarioData);
    setToken(tokenData);
    localStorage.setItem('sesion_north_ai', JSON.stringify({ usuarioData, tokenData }));
  }, [handleLogout, notificarAdvertencia]);

  // Recuperar y validar sesión persistente si el navegador se recarga
  useEffect(() => {
    const sesionGuardada = localStorage.getItem('sesion_north_ai');
    if (!sesionGuardada) {
      setCargando(false);
      return;
    }

    try {
      const { usuarioData, tokenData } = JSON.parse(sesionGuardada);

      if (!usuarioData || !tokenData || usuarioData.estado !== 'activo') {
        localStorage.removeItem('sesion_north_ai');
        setCargando(false);
        return;
      }

      // Validar token y estado activo contra el backend
      apiFetch('/api/perfil', {
        headers: { Authorization: `Bearer ${tokenData}` },
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error('Sesión no válida o cuenta inactiva');
          }
          return res.json();
        })
        .then((data) => {
          if (data.ok && data.usuario?.estado === 'activo') {
            setUsuario(data.usuario);
            setToken(tokenData);
          } else {
            handleLogout();
            notificarAdvertencia('El administrador aún no ha habilitado su cuenta para el sistema.', {
              titulo: 'Cuenta no habilitada',
              duracion: 6000,
            });
          }
        })
        .catch(() => {
          // Si el servidor falla o el token expiró, limpiar sesión
          handleLogout();
        })
        .finally(() => {
          setCargando(false);
        });
    } catch {
      localStorage.removeItem('sesion_north_ai');
      setCargando(false);
    }
  }, [handleLogout, notificarAdvertencia]);

  if (cargando) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#F8F9FA',
        color: '#475569',
        fontFamily: 'var(--font-body, sans-serif)',
        fontSize: '15px',
        fontWeight: 500,
      }}>
        Cargando sistema...
      </div>
    );
  }

  return (
    <div>
      {!usuario ? (
        <Login onLoginSuccess={handleLoginSuccess} />
      ) : (
        <Dashboard
          usuario={usuario}
          token={token}
          onLogout={handleLogout}
          onUsuarioActualizado={(usuarioData) => handleLoginSuccess(usuarioData, token)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <NotificationProvider>
      <AppContent />
    </NotificationProvider>
  );
}