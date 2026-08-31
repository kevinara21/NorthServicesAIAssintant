# Sistema de Diseño Corporativo - North Services AI Assistant

## Descripción General

El frontend de React ahora implementa un completo sistema de diseño corporativo que replica la identidad visual de North Services.

### Paleta de Colores Corporativos

- **Color Primario**: `#DD2226` (Rojo Corporativo)
- **Color Oscuro**: `#000000` (Negro Profundo)
- **Color Claro**: `#FFFFFF` (Blanco)
- **Texto Principal**: `#111827`
- **Texto Muted**: `#6B7280`

## Estructura de Archivos CSS

```
src/
├── index.css          # Variables globales + Reset + Tipografía
├── components.css     # Componentes reutilizables (botones, cards, forms)
├── animations.css     # Animaciones y transiciones
└── App.css           # Estilos específicos de la app
```

## Uso en Componentes React

### 1. Botones

```jsx
// Botón Primario Rojo
<button className="btn-enterprise btn-primary-red">Enviar</button>

// Botón con Outline Blanco
<button className="btn-enterprise btn-outline-white">Cancelar</button>

// Botón con Outline Oscuro
<button className="btn-enterprise btn-outline-dark">Más Info</button>
```

### 2. Tarjetas de Servicio

```jsx
<div className="card-service-enterprise">
  <div className="card-media-wrapper">
    <img src="image.jpg" alt="Servicio" />
  </div>
  <div className="card-body-wrapper">
    <h3>Título del Servicio</h3>
    <p>Descripción del servicio...</p>
  </div>
</div>
```

### 3. Tarjetas de Características

```jsx
<div className="card-feature-light">
  <h3>Característica Destacada</h3>
  <p>Descripción detallada...</p>
</div>
```

### 4. Formularios

```jsx
<form className="form-container">
  <h2>Formulario</h2>
  
  <div className="form-group">
    <label htmlFor="email" className="form-label">Email</label>
    <input 
      type="email" 
      id="email"
      className="form-control-enterprise"
      placeholder="tu@email.com"
    />
  </div>

  <div className="form-group">
    <label htmlFor="mensaje" className="form-label">Mensaje</label>
    <textarea 
      id="mensaje"
      className="form-control-enterprise"
      placeholder="Tu mensaje..."
    ></textarea>
  </div>

  <button className="btn-enterprise btn-primary-red">Enviar</button>
</form>
```

### 5. Sección Hero

```jsx
<div className="hero-enterprise">
  <div className="hero-bg-media">
    <img src="background.jpg" alt="Background" />
  </div>
  <div className="hero-overlay-gradient"></div>
  
  <div className="container">
    <div className="hero-content-wrapper">
      <h1>Título Principal</h1>
      <p>Subtítulo descriptivo</p>
      <div className="hero-btn-group">
        <button className="btn-enterprise btn-primary-red">Acción Principal</button>
        <button className="btn-enterprise btn-outline-white">Más Información</button>
      </div>
    </div>
  </div>
</div>
```

### 6. Grillas

```jsx
<div className="grid-3">
  <div className="card-service-enterprise">
    {/* Contenido */}
  </div>
  {/* Más tarjetas */}
</div>

// Otras opciones: grid-2, grid-4
```

### 7. Animaciones

```jsx
// Fade In
<div className="animate-fade-in">Contenido</div>

// Fade In Up (desde abajo)
<div className="animate-fade-in-up">Contenido</div>

// Slide In Left
<div className="animate-slide-in-left">Contenido</div>

// Scale In
<div className="animate-scale-in">Contenido</div>

// Pulse Glow (efecto de brillo pulsante)
<div className="animate-pulse-glow">Contenido</div>

// Bounce
<div className="animate-bounce">Contenido</div>
```

### 8. Badges

```jsx
<span className="badge-primary">Destacado</span>
<span className="badge-success">Completado</span>
```

### 9. Alertas

```jsx
<div className="alert alert-success">✓ Operación completada exitosamente</div>
<div className="alert alert-error">✗ Error en la operación</div>
<div className="alert alert-warning">⚠ Advertencia importante</div>
<div className="alert alert-info">ℹ Información relevante</div>
```

### 10. Utilidades de Texto

```jsx
<p className="text-primary">Texto en color primario</p>
<p className="text-muted">Texto atenuado</p>
<p className="text-center">Texto centrado</p>
<p className="text-uppercase">TEXTO EN MAYÚSCULAS</p>
```

## Variables CSS Disponibles

### Colores

```css
--color-primary: #DD2226
--color-primary-dark: #B5181C
--color-primary-light: #FF3B3F
--color-black: #000000
--color-white: #FFFFFF
--color-light-border: #E5E7EB
--color-text-main: #111827
--color-text-muted: #6B7280
```

### Tipografía

```css
--font-heading: 'Plus Jakarta Sans'
--font-body: 'Inter'
```

### Espaciado

```css
--space-xs: 0.5rem      /* 8px */
--space-sm: 1rem        /* 16px */
--space-md: 1.5rem      /* 24px */
--space-lg: 2.5rem      /* 40px */
--space-xl: 4rem        /* 64px */
--space-2xl: 6rem       /* 96px */
--space-3xl: 8rem       /* 128px */
```

### Transiciones

```css
--transition-fast: 0.2s cubic-bezier(0.16, 1, 0.3, 1)
--transition-medium: 0.35s cubic-bezier(0.16, 1, 0.3, 1)
--transition-slow: 0.6s cubic-bezier(0.16, 1, 0.3, 1)
```

### Sombras

```css
--shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.05)
--shadow-md: 0 8px 24px rgba(0, 0, 0, 0.08)
--shadow-lg: 0 16px 40px rgba(0, 0, 0, 0.12)
--shadow-glow: 0 0 30px rgba(221, 34, 38, 0.25)
```

### Border Radius

```css
--border-radius-sm: 4px
--border-radius-md: 8px
--border-radius-lg: 12px
--border-radius-xl: 20px
```

## Responsive Design

El sistema incluye breakpoints para diferentes dispositivos:

- **Desktop**: 1024px+
- **Tablet**: 768px - 1023px
- **Mobile**: < 768px

Todos los componentes son responsivos por defecto.

## Ejemplo de Página Completa

```jsx
import './App.css'

export default function App() {
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="container">
          <nav className="navbar">
            <a className="brand-logo" href="/">
              <img src="logo.png" alt="North Services" />
            </a>
            <ul className="nav-list">
              <li className="nav-item">
                <a className="nav-link active" href="/">Inicio</a>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="/servicios">Servicios</a>
              </li>
              <li className="nav-item">
                <a className="nav-link" href="/contacto">Contacto</a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main className="app-main">
        <section className="hero-enterprise">
          <div className="hero-bg-media">
            <img src="hero-bg.jpg" alt="Background" />
          </div>
          <div className="hero-overlay-gradient"></div>
          
          <div className="container">
            <div className="hero-content-wrapper animate-fade-in-up">
              <h1>Bienvenido a North Services</h1>
              <p>Soluciones empresariales de calidad superior</p>
              <div className="hero-btn-group">
                <button className="btn-enterprise btn-primary-red">
                  Comenzar Ahora
                </button>
                <button className="btn-enterprise btn-outline-white">
                  Más Información
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="section-padding">
          <div className="container">
            <div className="section-header">
              <h2>Nuestros <span>Servicios</span></h2>
              <p>Ofrecemos soluciones personalizadas para tu negocio</p>
            </div>

            <div className="grid-3">
              {/* Tarjetas de servicios */}
              {services.map((service) => (
                <div key={service.id} className="card-service-enterprise animate-fade-in-up">
                  <div className="card-media-wrapper">
                    <img src={service.image} alt={service.title} />
                  </div>
                  <div className="card-body-wrapper">
                    <h3>{service.title}</h3>
                    <p>{service.description}</p>
                    <a className="link-arrow-red" href={`/servicios/${service.id}`}>
                      Más Información →
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="container">
          <p>&copy; 2024 North Services. Todos los derechos reservados.</p>
        </div>
      </footer>
    </div>
  )
}
```

## Personalización

Para modificar el sistema de diseño globalmente, edita las variables CSS en `index.css`:

```css
:root {
  --color-primary: #DD2226;  /* Cambia el color primario aquí */
  /* ... resto de variables */
}
```

## Soporte

Todos los componentes incluyen:
- ✓ Diseño responsivo
- ✓ Transiciones suaves
- ✓ Estados hover/focus accesibles
- ✓ Animaciones optimizadas para rendimiento
- ✓ Compatibilidad con navegadores modernos

---

**Versión**: 1.0.0  
**Última actualización**: 2024  
**Autor**: Sistema de Diseño Corporativo North Services
