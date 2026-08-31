/* ==========================================================================
   EXAMPLE COMPONENT - Using Corporate Design System
   Componente de ejemplo usando el sistema de diseño corporativo
   ========================================================================== */

import './App.css'

export function ExampleComponent() {
  return (
    <div className="app-container">
      {/* HEADER */}
      <header className="app-header">
        <div className="container">
          <nav className="navbar">
            <div className="brand-logo">
              <span style={{ fontSize: '1.25rem', fontWeight: 800, color: 'white' }}>
                North Services
              </span>
            </div>
            <ul className="nav-list">
              <li className="nav-item">
                <a className="nav-link active" href="#inicio">
                  Inicio
                </a>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="#servicios">
                  Servicios
                </a>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="#contacto">
                  Contacto
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main className="app-main">
        {/* HERO SECTION */}
        <section className="hero-enterprise">
          <div className="hero-overlay-gradient"></div>
          
          <div className="container">
            <div className="hero-content-wrapper animate-fade-in-up">
              <h1>Bienvenido a North Services</h1>
              <p>Soluciones empresariales de calidad superior con tecnología de punta</p>
              <div className="hero-btn-group">
                <button className="btn-enterprise btn-primary-red">
                  Comenzar Ahora
                </button>
                <button className="btn-enterprise btn-outline-white">
                  Ver Servicios
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* SERVICES SECTION */}
        <section className="section-padding" id="servicios">
          <div className="container">
            <div className="section-header">
              <h2>Nuestros <span className="text-primary">Servicios</span></h2>
              <p>Ofrecemos soluciones integrales para transformar tu negocio</p>
            </div>

            <div className="grid-3">
              {/* Service Card 1 */}
              <div className="card-service-enterprise animate-fade-in-up">
                <div className="card-media-wrapper">
                  <div style={{
                    width: '100%',
                    height: '100%',
                    background: 'linear-gradient(135deg, var(--color-primary), var(--color-primary-dark))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '3rem',
                  }}>
                    🚀
                  </div>
                </div>
                <div className="card-body-wrapper">
                  <h3>Consultoría Empresarial</h3>
                  <p>Asesoramiento estratégico para el crecimiento sostenible de tu empresa</p>
                  <a className="link-arrow-red" href="#servicios">
                    Más Información →
                  </a>
                </div>
              </div>

              {/* Service Card 2 */}
              <div className="card-service-enterprise animate-fade-in-up">
                <div className="card-media-wrapper">
                  <div style={{
                    width: '100%',
                    height: '100%',
                    background: 'linear-gradient(135deg, #1F2937, #111827)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '3rem',
                  }}>
                    💼
                  </div>
                </div>
                <div className="card-body-wrapper">
                  <h3>Desarrollo de Software</h3>
                  <p>Soluciones tecnológicas personalizadas y escalables para tu negocio</p>
                  <a className="link-arrow-red" href="#servicios">
                    Más Información →
                  </a>
                </div>
              </div>

              {/* Service Card 3 */}
              <div className="card-service-enterprise animate-fade-in-up">
                <div className="card-media-wrapper">
                  <div style={{
                    width: '100%',
                    height: '100%',
                    background: 'linear-gradient(135deg, #374151, #1F2937)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '3rem',
                  }}>
                    📊
                  </div>
                </div>
                <div className="card-body-wrapper">
                  <h3>Análisis de Datos</h3>
                  <p>Insights valiosos basados en datos para tomar mejores decisiones</p>
                  <a className="link-arrow-red" href="#servicios">
                    Más Información →
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FEATURES SECTION */}
        <section className="section-padding" style={{ backgroundColor: 'var(--color-light-surface)' }}>
          <div className="container">
            <div className="section-header">
              <h2>¿Por qué elegir North Services?</h2>
              <p>Nos destacamos por nuestro compromiso con la excelencia</p>
            </div>

            <div className="grid-2">
              <div className="card-feature-light animate-fade-in-up">
                <h4>✓ Experiencia Comprobada</h4>
                <p>Más de 10 años trabajando con empresas líderes en la industria</p>
              </div>

              <div className="card-feature-light animate-fade-in-up">
                <h4>✓ Equipo Profesional</h4>
                <p>Especialistas altamente capacitados en cada área de expertise</p>
              </div>

              <div className="card-feature-light animate-fade-in-up">
                <h4>✓ Tecnología de Punta</h4>
                <p>Utilizamos las herramientas y frameworks más modernos</p>
              </div>

              <div className="card-feature-light animate-fade-in-up">
                <h4>✓ Soporte 24/7</h4>
                <p>Estamos disponibles para ayudarte en cualquier momento</p>
              </div>
            </div>
          </div>
        </section>

        {/* CONTACT FORM SECTION */}
        <section className="section-padding" id="contacto">
          <div className="container">
            <div className="section-header">
              <h2>Contáctanos</h2>
              <p>Completa el formulario y nos pondremos en contacto contigo pronto</p>
            </div>

            <form className="form-container animate-fade-in-up">
              <div className="form-group">
                <label htmlFor="nombre" className="form-label">Nombre Completo</label>
                <input
                  type="text"
                  id="nombre"
                  className="form-control-enterprise"
                  placeholder="Tu nombre"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="email" className="form-label">Email</label>
                <input
                  type="email"
                  id="email"
                  className="form-control-enterprise"
                  placeholder="tu@email.com"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="empresa" className="form-label">Empresa</label>
                <input
                  type="text"
                  id="empresa"
                  className="form-control-enterprise"
                  placeholder="Tu empresa"
                />
              </div>

              <div className="form-group">
                <label htmlFor="mensaje" className="form-label">Mensaje</label>
                <textarea
                  id="mensaje"
                  className="form-control-enterprise"
                  placeholder="Cuéntanos sobre tu proyecto..."
                  required
                ></textarea>
              </div>

              <button type="submit" className="btn-enterprise btn-primary-red">
                Enviar Mensaje
              </button>
            </form>
          </div>
        </section>

        {/* ALERTS EXAMPLE */}
        <section className="section-padding" style={{ backgroundColor: '#f9fafb' }}>
          <div className="container">
            <div className="section-header">
              <h2>Tipos de Notificaciones</h2>
            </div>

            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
              <div className="alert alert-success">
                ✓ Operación completada exitosamente
              </div>

              <div className="alert alert-error">
                ✗ Hubo un error durante la operación
              </div>

              <div className="alert alert-warning">
                ⚠ Advierte importante que debe considerarse
              </div>

              <div className="alert alert-info">
                ℹ Información relevante para el usuario
              </div>
            </div>
          </div>
        </section>

        {/* BADGES EXAMPLE */}
        <section className="section-padding">
          <div className="container">
            <div className="section-header">
              <h2>Badges y Etiquetas</h2>
            </div>

            <div style={{
              textAlign: 'center',
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
              justifyContent: 'center'
            }}>
              <span className="badge-primary">Destacado</span>
              <span className="badge-primary">Nuevo</span>
              <span className="badge-success">Completado</span>
              <span className="badge-success">Activo</span>
            </div>
          </div>
        </section>
      </main>

      {/* FOOTER */}
      <footer className="app-footer">
        <div className="container" style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
          <p>&copy; 2024 North Services AI Assistant. Todos los derechos reservados.</p>
          <p style={{ fontSize: '0.875rem', marginTop: '1rem' }}>
            Sistema de Diseño Corporativo v1.0.0
          </p>
        </div>
      </footer>
    </div>
  )
}

export default ExampleComponent
