import { useState } from 'react';
import {
  FiBookOpen,
  FiBox,
  FiChevronRight,
  FiExternalLink,
  FiHome,
  FiLogOut,
  FiMessageCircle,
  FiMenu,
  FiSettings,
  FiUploadCloud,
  FiUser,
  FiUsers,
  FiX,
} from 'react-icons/fi';
import Chatbot from '../pages/Chatbot';
import GestionUsuarios from '../pages/GestionUsuarios';
import CatalogoSoftware from './CatalogoSoftware';
import ModuloManuales from './ModuloManuales';
import SubirRecursos from './SubirRecursos';
import Perfil from './Perfil';

const normalizarRol = (rol = '') =>
  rol.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export default function Dashboard({ usuario, token, onLogout, onUsuarioActualizado }) {
  const [vistaActiva, setVistaActiva] = useState('inicio');
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [asistenteAbierto, setAsistenteAbierto] = useState(false);
  const esAdministrador = normalizarRol(usuario?.rol) === 'administrador';
  const nombreCompleto = [usuario?.nombre, usuario?.apellido].filter(Boolean).join(' ') || 'Usuario';

  const opcionesPrincipales = [
    { id: 'inicio', label: 'Inicio', icon: FiHome },
    { id: 'manuales', label: 'Manuales', icon: FiBookOpen },
    { id: 'software', label: 'Software', icon: FiBox },
    { id: 'perfil', label: 'Perfil', icon: FiUser },
  ];

  const opcionesAdmin = [
    { id: 'recursos', label: 'Subir recursos', icon: FiUploadCloud },
    { id: 'usuarios', label: 'Gestionar usuarios', icon: FiUsers },
  ];

  const cambiarVista = (vista) => {
    setVistaActiva(vista);
    setMenuAbierto(false);
  };

  const renderVista = () => {
    switch (vistaActiva) {
      case 'manuales': return <ModuloManuales token={token} />;
      case 'software': return <CatalogoSoftware token={token} />;
      case 'recursos': return <SubirRecursos token={token} />;
      case 'usuarios': return <GestionUsuarios token={token} />;
      case 'perfil': return <Perfil usuario={usuario} token={token} onUsuarioActualizado={onUsuarioActualizado} />;
      default:
        return (
          <section className="dashboard-home-layout">
            <div className="dashboard-home-main dashboard-welcome">
              <span className="dashboard-eyebrow">Panel de control</span>
              <h1>Bienvenido, {usuario?.nombre || 'usuario'}</h1>
              <p>North Services &amp; Rental Tools es un aliado estratégico para la industria petrolera, con soluciones técnicas, herramientas especializadas y operaciones orientadas a la seguridad y la eficiencia.</p>
              <h3 className="dashboard-home-title">Tus herramientas</h3>
              <div className="dashboard-quick-links">
                {opcionesPrincipales.slice(1).map(({ id, label, icon: Icon }) => (
                  <button type="button" key={id} onClick={() => cambiarVista(id)}>
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                    <FiChevronRight aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
            <aside className="company-pages">
              <span className="dashboard-eyebrow">Páginas</span>
              <div className="company-overview">
                <span className="company-overview-label">North Services &amp; Rental Tools</span>
                <p>Desde 2009, desarrollamos servicios de perforación direccional, SlickLine, fluidos de perforación, cementación, fractura y acidificación para proyectos exigentes en la región.</p>
                <a href="https://northservices.com.pe/" target="_blank" rel="noreferrer">
                  Conocer la empresa
                  <FiExternalLink aria-hidden="true" />
                </a>
              </div>
              <div className="company-inventory-links">
                <a href="https://northservices.com.pe/inventorymwd/" target="_blank" rel="noreferrer">
                  <span>
                    <strong>Inventario MWD / LWD</strong>
                    <small>Herramientas de medición y registro durante la perforación</small>
                  </span>
                  <FiExternalLink aria-hidden="true" />
                </a>
                <a href="https://northservices.com.pe/inventorymotors/" target="_blank" rel="noreferrer">
                  <span>
                    <strong>Inventario Motors</strong>
                    <small>Equipos, motores y componentes disponibles</small>
                  </span>
                  <FiExternalLink aria-hidden="true" />
                </a>
              </div>
            </aside>
          </section>
        );
    }
  };

  const renderOpciones = (opciones) => opciones.map(({ id, label, icon: Icon }) => (
    <button
      type="button"
      key={id}
      className={`dashboard-nav-item ${vistaActiva === id ? 'active' : ''}`}
      onClick={() => cambiarVista(id)}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  ));

  return (
    <div className="dashboard-shell">
      <button
        type="button"
        className="dashboard-menu-toggle"
        aria-label={menuAbierto ? 'Cerrar menú' : 'Abrir menú'}
        onClick={() => setMenuAbierto((abierto) => !abierto)}
      >
        {menuAbierto ? <FiX aria-hidden="true" /> : <FiMenu aria-hidden="true" />}
      </button>

      {menuAbierto && <button type="button" className="dashboard-backdrop" aria-label="Cerrar menú" onClick={() => setMenuAbierto(false)} />}

      <aside className={`dashboard-sidebar ${menuAbierto ? 'open' : ''}`}>
        <div className="dashboard-brand">
          <img src="/NorthServices.svg" alt="North Services" />
        </div>

        <div className="dashboard-user">
          <strong>{nombreCompleto}</strong>
          <span className="dashboard-role"><FiSettings aria-hidden="true" /> {esAdministrador ? 'Administrador' : (usuario?.rol || 'Usuario')}</span>
        </div>

        <nav className="dashboard-nav" aria-label="Navegación principal">
          <span className="dashboard-nav-title">General</span>
          {renderOpciones(opcionesPrincipales)}

          {esAdministrador && (
            <>
              <span className="dashboard-nav-title dashboard-nav-title-admin">Administración</span>
              {renderOpciones(opcionesAdmin)}
            </>
          )}
        </nav>

        <div className="dashboard-sidebar-footer">
          <button type="button" className="dashboard-logout" onClick={onLogout}>
            <FiLogOut aria-hidden="true" />
            <span>Cerrar sesión</span>
          </button>
        </div>
      </aside>

      <main className="dashboard-content">
        <header className="dashboard-topbar">
          <div>
            <span className="dashboard-section-label">North Services AI Assistant</span>
            <h2>{[...opcionesPrincipales, ...opcionesAdmin].find((opcion) => opcion.id === vistaActiva)?.label || 'Inicio'}</h2>
          </div>
          <div className="dashboard-topbar-user">
            <span>{usuario?.email || 'Sesión activa'}</span>
            <span className="dashboard-avatar">{(usuario?.nombre || 'U').charAt(0).toUpperCase()}</span>
          </div>
        </header>
        <div className="dashboard-view">{renderVista()}</div>
      </main>

      {asistenteAbierto && (
        <section className="floating-ai-panel" aria-label="Asistente Virtual IA">
          <header className="floating-ai-header">
            <div>
              <strong>Asistente Virtual IA</strong>
            </div>
          </header>
          <div className="floating-ai-content">
            <Chatbot token={token} />
          </div>
        </section>
      )}

      <button
        type="button"
        className={`floating-ai-button ${asistenteAbierto ? 'active' : ''}`}
        aria-label={asistenteAbierto ? 'Cerrar asistente virtual' : 'Abrir asistente virtual'}
        onClick={() => setAsistenteAbierto((abierto) => !abierto)}
      >
        {asistenteAbierto ? <FiX aria-hidden="true" /> : <FiMessageCircle aria-hidden="true" />}
        <span>{asistenteAbierto ? 'Cerrar' : 'Asistente IA'}</span>
      </button>
    </div>
  );
}