import React from 'react';

export default function OilLoader({ label = 'Cargando', inline = false }) {
  return (
    <div className={`oil-loader${inline ? ' inline' : ''}`}>
      <div className="pumpjack" aria-hidden="true">
        <div className="pumpjack-crank" />
        <div className="pumpjack-post" />
        <div className="pumpjack-beam">
          <div className="pumpjack-head" />
        </div>
        <div className="pumpjack-rod" />
        <div className="oil-drop" />
        <div className="pumpjack-ground" />
      </div>
      <p className="oil-loader-label">
        {label}
        <span>...</span>
      </p>
    </div>
  );
}
