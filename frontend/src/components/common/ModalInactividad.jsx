import { FiAlertTriangle } from 'react-icons/fi';

export default function ModalInactividad({ cuentaRegresivaTexto, progreso }) {
  return (
    <div className="modal-overlay modal-monitoreo-pozo-overlay inactividad-overlay" role="alertdialog" aria-modal="true" aria-label="Aviso de inactividad">
      <div className="modal-monitoreo-pozo modal-monitoreo-pozo-inactividad">
        <header className="modal-monitoreo-pozo-header">
          <div>
            <span className="dashboard-eyebrow">Seguridad</span>
            <h2><FiAlertTriangle aria-hidden="true" /> Sesión por expirar</h2>
          </div>
        </header>
        <div className="modal-monitoreo-pozo-body">
          <p className="modal-monitoreo-pozo-intro">
            Se han detectado 15 minutos de inactividad. Por seguridad, tu sesión se cerrará en los siguientes minutos.
          </p>
          <div className="inactividad-barra" role="timer" aria-live="polite">
            <div className="inactividad-barra-relleno" style={{ width: `${progreso * 100}%` }} />
          </div>
          <p className="inactividad-contador">{cuentaRegresivaTexto}</p>
        </div>
      </div>
    </div>
  );
}
