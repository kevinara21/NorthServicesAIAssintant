import { useState, useEffect, useCallback, useRef } from 'react';
import { NotificationProvider, useNotification } from './context/NotificationContext';
import Login from './pages/Login';
import Dashboard from './components/Dashboard';
import OilLoader from './components/common/OilLoader';
import ModalInactividad from './components/common/ModalInactividad';
import useSesionSegura from './hooks/useSesionSegura';
import { apiFetch } from './services/api';

const CLAVE_RECARGAS = 'recargas_north_ai';
const UMBRAL_RECARGAS = 5;
const VENTANA_RECARGAS_MS = 7000;

function AppContent() {
  const [usuario, setUsuario] = useState(null);
  const [token, setToken] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [enLinea, setEnLinea] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [inicioSesion, setInicioSesion] = useState(null);
  const bloquearRestaurar = useRef(false);
  const recargaRegistrada = useRef(false);
  const logoutNotificado = useRef(false);
  const { notificarAdvertencia } = useNotification();

  const handleLogout = useCallback(() => {
    setUsuario(null);
    setToken(null);
    setInicioSesion(null);
    localStorage.removeItem('sesion_north_ai');
  }, []);

  const cerrarPorRecargasSospechosas = useCallback(() => {
    if (logoutNotificado.current) return;
    logoutNotificado.current = true;

    bloquearRestaurar.current = true;
    try {
      sessionStorage.removeItem(CLAVE_RECARGAS);
    } catch { /* no-op */ }
    localStorage.removeItem('sesion_north_ai');
    setUsuario(null);
    setToken(null);
    setInicioSesion(null);
    setCargando(false);
  }, []);

  // Muestra los scrollbars rojos del sistema solo mientras el usuario se desplaza
  useEffect(() => {
    let timer;
    const manejarScrollGlobal = () => {
      document.documentElement.classList.add('is-scrolling');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => document.documentElement.classList.remove('is-scrolling'), 600);
    };
    window.addEventListener('scroll', manejarScrollGlobal, true);
    return () => {
      window.removeEventListener('scroll', manejarScrollGlobal, true);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Detector de conexión a Internet (2A)
  useEffect(() => {
    const conectar = () => setEnLinea(true);
    const desconectar = () => setEnLinea(false);
    window.addEventListener('online', conectar);
    window.addEventListener('offline', desconectar);
    return () => {
      window.removeEventListener('online', conectar);
      window.removeEventListener('offline', desconectar);
    };
  }, []);

  // Protección contra recargas múltiples sospechosas.
  //
  // - Umbral: 5 recargas RÁPIDAS dentro de una ventana de 7 segundos.
  // - El doble-mount de StrictMode (desarrollo) no contabiliza de más porque
  //   `recargaRegistrada` asegura un único conteo por carga real de la app.
  // - En pantallas sin sesión (login) se resetea el contador para evitar falsos
  //   positivos al navegar o desarrollar.
  useEffect(() => {
    if (recargaRegistrada.current) return;
    recargaRegistrada.current = true;

    if (!localStorage.getItem('sesion_north_ai')) {
      sessionStorage.removeItem(CLAVE_RECARGAS);
      return;
    }

    const ahora = Date.now();
    let marcas = [];
    try {
      marcas = JSON.parse(sessionStorage.getItem(CLAVE_RECARGAS) || '[]');
    } catch {
      marcas = [];
    }
    marcas = marcas.filter((marca) => ahora - marca < VENTANA_RECARGAS_MS);
    marcas.push(ahora);
    sessionStorage.setItem(CLAVE_RECARGAS, JSON.stringify(marcas));

    if (marcas.length >= UMBRAL_RECARGAS) {
      cerrarPorRecargasSospechosas();
    }
  }, [cerrarPorRecargasSospechosas]);

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

    const inicio = Date.now();
    setUsuario(usuarioData);
    setToken(tokenData);
    setInicioSesion(inicio);
    localStorage.setItem('sesion_north_ai', JSON.stringify({ usuarioData, tokenData, inicioSesion: inicio }));
  }, [handleLogout, notificarAdvertencia]);

  // Recuperar y validar sesión persistente si el navegador se recarga
  useEffect(() => {
    if (bloquearRestaurar.current) return;
    const sesionGuardada = localStorage.getItem('sesion_north_ai');
    if (!sesionGuardada) {
      setCargando(false);
      return;
    }

    try {
      const { usuarioData, tokenData, inicioSesion: inicioGuardado } = JSON.parse(sesionGuardada);

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
            setInicioSesion(inicioGuardado || Date.now());
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

  // Temporizador de inactividad + tiempo restante de sesión (2B, 2C)
  const { tiempoSesionTexto, mostrarModalInactividad, cuentaRegresivaTexto, progresoCierre } = useSesionSegura({
    activo: Boolean(usuario),
    inicioSesion,
    onExpirar: handleLogout,
  });

  if (cargando) {
    return <OilLoader label="Cargando sistema" />;
  }

  return (
    <div>
      {!enLinea && (
        <div className="banner-sin-conexion" role="status">
          Sin conexión a Internet. Las funciones de consulta y descarga están pausadas.
        </div>
      )}
      {!usuario ? (
        <Login onLoginSuccess={handleLoginSuccess} />
      ) : (
        <Dashboard
          usuario={usuario}
          token={token}
          onLogout={handleLogout}
          tiempoSesionTexto={tiempoSesionTexto}
          onUsuarioActualizado={(usuarioData) => handleLoginSuccess(usuarioData, token)}
        />
      )}
      {usuario && mostrarModalInactividad && (
        <ModalInactividad cuentaRegresivaTexto={cuentaRegresivaTexto} progreso={progresoCierre} />
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
