# GUÍA DE COLORES CORPORATIVOS - North Services

## ✓ Actualización Completada

Todos los componentes del frontend React ahora utilizan exclusivamente la paleta corporativa de North Services.

---

## Paleta Corporativa Oficial

### Colores Primarios
- **Rojo Corporativo**: `#DD2226` - Color principal de marca
- **Negro Puro**: `#000000` - Fondos oscuros y headers
- **Blanco**: `#FFFFFF` - Fondos claros y texto sobre rojo

### Colores Secundarios (Neutros)
- **Gris Claro**: `#F8F9FA` - Fondos secundarios
- **Gris Frontera**: `#E5E7EB` - Borders y divisores
- **Gris Medio**: `#6B7280` - Texto secundario/muted
- **Gris Etiqueta**: `#FFE5E7` - Badges y tags (rojo muy claro)

---

## Uso en Componentes

### Botones
```jsx
// Botón primario
<button style={{ background: '#DD2226', color: '#FFFFFF' }}>Acción</button>

// Botón secundario
<button style={{ background: '#666666', color: '#FFFFFF' }}>Secundario</button>
```

### Cards y Contenedores
```jsx
<div style={{ 
  background: '#FFFFFF', 
  border: '1px solid #E5E7EB',
  borderRadius: 8
}}>
  Contenido
</div>
```

### Texto
```jsx
// Texto principal
<p style={{ color: '#111827' }}>Texto principal</p>

// Texto secundario
<p style={{ color: '#6B7280' }}>Texto muted</p>

// Encabezados
<h1 style={{ color: '#000000', fontWeight: 700 }}>Título</h1>
```

### Badges y Etiquetas
```jsx
<span style={{ 
  background: '#FFE5E7', 
  color: '#DD2226',
  borderRadius: 4,
  padding: '2px 8px'
}}>
  Etiqueta
</span>
```

---

## Componentes Actualizados ✓

| Componente | Estado | Cambios |
|-----------|--------|---------|
| Login.jsx | ✓ Completo | Botones rojo, labels negro, inputs blanco |
| Register.jsx | ✓ Completo | Formularios corporativos, alertas rojo |
| Dashboard.jsx | ✓ Completo | Header negro, botones rojo, chat rojo |
| CatalogoSoftware.jsx | ✓ Completo | Tarjetas blancas, botones rojo |
| ModuloManuales.jsx | ✓ Completo | Tarjetas blancas, botones rojo |
| SubirRecursos.jsx | ✓ Completo | Barra progreso rojo, botones rojo |
| App.css | ✓ Completo | Sistema completo de estilos |
| index.css | ✓ Completo | Variables CSS corporativas |
| components.css | ✓ Completo | Componentes reutilizables |
| animations.css | ✓ Completo | Animaciones smooth |

---

## Versión del Sistema

**Sistema de Diseño**: v1.0.0  
**Última Actualización**: 31 Agosto 2024  
**Organización**: North Services  
**Colores Corporativos**: Rojo #DD2226, Negro #000000, Blanco #FFFFFF

---

## Notas Importantes

1. ✓ **Sin colores azules** - Todos los azules (#2563eb, #0284c7) han sido reemplazados por rojo corporativo
2. ✓ **Sistema consistente** - Todos los componentes siguen la misma paleta
3. ✓ **Accesibilidad** - Contraste adecuado entre colores para cumplir WCAG
4. ✓ **Responsive** - Funciona en todos los dispositivos
5. ✓ **Performance** - CSS optimizado sin código duplicado

---

## Referencia Rápida de Colores Antiguos → Nuevos

| Anterior | Nuevo | Uso |
|----------|-------|-----|
| `#2563eb` (Azul) | `#DD2226` (Rojo) | Botones primarios |
| `#0284c7` (Cyan) | `#DD2226` (Rojo) | Botones secundarios |
| `#1e293b` (Gris oscuro) | `#000000` (Negro) | Headers y fondos |
| `#f1f5f9` (Gris claro) | `#F8F9FA` (Gris claro) | Fondos |
| `#cbd5e1` (Borde) | `#E5E7EB` (Borde) | Bordes |
| `#64748b` (Texto) | `#6B7280` (Texto) | Texto muted |

---

## Próximas Mejoras

- [ ] Dark mode con la paleta corporativa
- [ ] Animaciones de carga corporativas
- [ ] Iconografía personalizada
- [ ] Componentes adicionales (modales, tooltips)
- [ ] Temas por rol de usuario

---

**Documento oficial del Sistema de Diseño Corporativo North Services**  
Para consultas o actualizaciones, refierase a la documentación principal en `DESIGN_SYSTEM.md`
