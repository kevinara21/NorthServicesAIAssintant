import { useEffect, useRef, useState } from 'react';
import {
  FiBookOpen,
  FiFolder,
  FiChevronRight,
  FiExternalLink,
  FiWifi,
  FiHome,
  FiLogOut,
  FiMenu,
  FiSettings,
  FiUploadCloud,
  FiUser,
  FiUsers,
  FiX,
  FiMonitor,
  FiTrash2,
} from 'react-icons/fi';
import { FaRobot } from 'react-icons/fa';
import Chatbot from '../pages/Chatbot';
import GestionUsuarios from '../pages/GestionUsuarios';
import GestionFacturacion from '../pages/GestionFacturacion';
import SubirRecursos from './SubirRecursos';
import Perfil from './Perfil';
import Recursos from './Recursos';
import Archivos from './Archivos';
import MonitoreoPozos from './MonitoreoPozos';
import Papelera from '../pages/Papelera';

const normalizarRol = (rol = '') =>
  rol.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export default function Dashboard({ usuario, token, onLogout, onUsuarioActualizado }) {
const [vistaActiva, setVistaActiva] = useState('inicio');
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [asistenteAbierto, setAsistenteAbierto] = useState(false);
  const [monitoreoAbierto, setMonitoreoAbierto] = useState(false);
  const panelAsistenteRef = useRef(null);
  const botonAsistenteRef = useRef(null);
  const navRef = useRef(null);
  const ocultarNavTimerRef = useRef(null);

  const manejarScrollNav = () => {
    const nav = navRef.current;
    if (!nav) return;
    nav.classList.add('scrolling');
    if (ocultarNavTimerRef.current) clearTimeout(ocultarNavTimerRef.current);
    ocultarNavTimerRef.current = setTimeout(() => nav.classList.remove('scrolling'), 500);
  };
  const esAdministrador = normalizarRol(usuario?.rol) === 'administrador';
  const nombreCompleto = [usuario?.nombre, usuario?.apellido].filter(Boolean).join(' ') || 'Usuario';

  useEffect(() => {
    if (!asistenteAbierto) return undefined;
    const manejarClickFuera = (evento) => {
      const dentroDelPanel = panelAsistenteRef.current?.contains(evento.target);
      const dentroDelBoton = botonAsistenteRef.current?.contains(evento.target);
      if (!dentroDelPanel && !dentroDelBoton) setAsistenteAbierto(false);
    };
    document.addEventListener('mousedown', manejarClickFuera);
    return () => document.removeEventListener('mousedown', manejarClickFuera);
  }, [asistenteAbierto]);

  const opcionesPrincipales = [
    { id: 'inicio', label: 'Inicio', icon: FiHome },
    { id: 'recursos', label: 'Recursos', icon: FiBookOpen },
    { id: 'archivos', label: 'Archivos', icon: FiFolder },
    { id: 'papelera', label: 'Papelera', icon: FiTrash2 },
    { id: 'perfil', label: 'Perfil', icon: FiUser },
  ];

  const opcionesAdmin = [
    { id: 'publicar-recursos', label: 'Publicar recursos', icon: FiUploadCloud },
    { id: 'usuarios', label: 'Gestionar usuarios', icon: FiUsers },
    { id: 'facturacion', label: 'Starlink', icon: FiWifi },
  ];

  const cambiarVista = (vista) => {
    setVistaActiva(vista);
    setMenuAbierto(false);
  };

  const renderVista = () => {
    switch (vistaActiva) {
      case 'recursos': return <Recursos token={token} esAdministrador={esAdministrador} />;
case 'archivos': return <Archivos token={token} usuario={usuario} />;
      case 'publicar-recursos': return <SubirRecursos token={token} />;
      case 'usuarios': return <GestionUsuarios token={token} />;
      case 'facturacion': return <GestionFacturacion token={token} />;
      case 'papelera': return <Papelera token={token} usuario={usuario} />;
      case 'perfil': return <Perfil usuario={usuario} token={token} onUsuarioActualizado={onUsuarioActualizado} />;
      default:
        return (
          <section className="dashboard-home-layout">
            <div className="dashboard-home-main dashboard-welcome">
              <span className="dashboard-eyebrow">Menú principal</span>
              <h1>Bienvenid@, {usuario?.nombre || 'usuario'}</h1>
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
                <p>Desde 2009, desarrollamos servicios de Perforación Direccional, SlickLine, Fluidos de Perforación, Cementación, Fractura y Acidificación para proyectos exigentes en la región.</p>
                <a href="https://northservices.com.pe/" target="_blank" rel="noreferrer">
                  Página oficial
                  <FiExternalLink aria-hidden="true" />
                </a>
              </div>
              <div className="company-inventory-links">
                <a href="https://drive.google.com/drive/folders/1Bdm_qnQ_ccSnL2MRTFfJHoPnwHju5DYd?usp=sharing" target="_blank" rel="noreferrer">
                  <span>
                    <strong>Drive compartido</strong>
                    <small>Acceso a la carpeta compartida de recursos de la empresa</small>
                  </span>
                  <FiExternalLink aria-hidden="true" />
                </a>
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
                <button type="button" className="company-inventory-link-button" onClick={() => setMonitoreoAbierto(true)}>
                  <span>
                    <strong>Monitoreo de pozos</strong>
                    <small>Monitoreo remoto en vivo - enlaces compartidos</small>
                  </span>
                  <FiMonitor aria-hidden="true" />
                </button>
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

        <nav className="dashboard-nav" ref={navRef} onScroll={manejarScrollNav} aria-label="Navegación principal">
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
          </div>
          <div className="dashboard-topbar-user">
            <span>{usuario?.email || 'Sesión activa'}</span>
            <span className="dashboard-avatar">{(usuario?.nombre || 'U').charAt(0).toUpperCase()}</span>
          </div>
        </header>
        <div className="dashboard-view">{renderVista()}</div>
      </main>

      {monitoreoAbierto && (
        <MonitoreoPozos token={token} usuario={usuario} onCerrar={() => setMonitoreoAbierto(false)} />
      )}

      <section className={`floating-ai-panel ${asistenteAbierto ? '' : 'closed'}`} aria-label="Asistente Virtual IA" aria-hidden={!asistenteAbierto} ref={panelAsistenteRef}>
          <header className="floating-ai-header">
            <div>
              <strong>Asistente Virtual IA</strong>
            </div>
          </header>
          <div className="floating-ai-content">
            <Chatbot token={token} uid={usuario?.uid} />
          </div>
        </section>

      <button
        type="button"
        ref={botonAsistenteRef}
        className={`floating-ai-button ${asistenteAbierto ? 'active' : ''}`}
        aria-label={asistenteAbierto ? 'Cerrar asistente virtual' : 'Abrir asistente virtual'}
        onClick={() => setAsistenteAbierto((abierto) => !abierto)}
      >
        {asistenteAbierto ? <FiX aria-hidden="true" /> : <FaRobot aria-hidden="true" />}
        <span>{asistenteAbierto ? 'Cerrar' : 'IA'}</span>
      </button>
    </div>
  );
}
