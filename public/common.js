// common.js (se carga en todas las páginas que hagan fetch)

// Mostrar mensaje rápido
function mostrarMensaje(texto) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = texto;
  } else {
    alert(texto);
  }
}

// POST JSON tolerante: si llega HTML (p.ej. 502) no revienta
async function postJSON(url, data) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} - ${text.slice(0, 120)}`);
  }

  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Respuesta no-JSON: ${text.slice(0, 120)}`);
  }

  return resp.json();
}

// Cerrar sesión sin tocar backend (borra el storage y redirige)
function cerrarSesion() {
  try {
    sessionStorage.clear();
    localStorage.clear();
  } finally {
    window.location.href = 'usuario-login.html';
  }
}

// ── Timer de inactividad automático ─────────────────────────────────────────
// Se activa automáticamente según la página detectada.
// - Páginas admin:      30 min → redirige a admin-login.html
// - Páginas usuario:    ya lo tienen en usuario.html (no se duplica)
// - Páginas supervisor: ya lo tienen en supervisor.html (no se duplica)
(function initInactivityTimer() {
  // Detectar tipo de página por URL
  const path = window.location.pathname;
  const isAdmin = /\/(admin|corregir|crear-usuario|eliminar|empleados|reporte|reset-password|supervisores)/.test(path);
  if (!isAdmin) return; // usuario.html y supervisor.html manejan su propio timer

  // Inyectar barra si no existe ya (admin.html la pone manualmente)
  if (!document.getElementById('inactivity-bar-wrap')) {
    const style = document.createElement('style');
    style.textContent = `
      #inactivity-bar-wrap{max-width:100%;background:#e0e0e0;height:5px;overflow:hidden;position:fixed;top:0;left:0;right:0;z-index:9999;}
      #inactivity-bar{height:100%;width:100%;background:#84a900;}
      #inactivity-label{position:fixed;top:5px;right:8px;font-size:10px;color:#888;z-index:9999;background:rgba(255,255,255,0.85);padding:1px 6px;border-radius:4px;}
    `;
    document.head.appendChild(style);

    const wrap  = document.createElement('div'); wrap.id  = 'inactivity-bar-wrap';
    const bar   = document.createElement('div'); bar.id   = 'inactivity-bar';
    const label = document.createElement('div'); label.id = 'inactivity-label';
    label.textContent = 'Sesión activa';
    wrap.appendChild(bar);
    document.body.insertBefore(wrap,  document.body.firstChild);
    document.body.insertBefore(label, document.body.firstChild);
  }

  const TIMEOUT_MS = 30 * 60 * 1000;
  const WARNING_MS =  3 * 60 * 1000;
  let timerID, startTime, rafID;
  const bar   = document.getElementById('inactivity-bar');
  const label = document.getElementById('inactivity-label');

  function animarBarra() {
    if (!bar || !label) return;
    const elapsed = Date.now() - startTime;
    const pct     = Math.min(elapsed / TIMEOUT_MS, 1);
    const restMs  = Math.max(TIMEOUT_MS - elapsed, 0);
    const restMin = Math.floor(restMs / 60000);
    const restSec = Math.floor((restMs % 60000) / 1000);
    bar.style.width = (100 - pct * 100).toFixed(1) + '%';
    if (restMs <= WARNING_MS) {
      bar.style.background  = '#ea1902';
      label.style.color     = '#ea1902';
      label.textContent     = `⚠️ Sesión cierra en ${restMin}:${String(restSec).padStart(2,'0')} min`;
    } else {
      bar.style.background  = '#84a900';
      label.style.color     = '#888';
      label.textContent     = `Sesión activa — cierra en ${restMin}:${String(restSec).padStart(2,'0')} min`;
    }
    if (pct < 1) rafID = requestAnimationFrame(animarBarra);
  }

  function reiniciar() {
    clearTimeout(timerID);
    cancelAnimationFrame(rafID);
    startTime = Date.now();
    animarBarra();
    timerID = setTimeout(() => {
      alert('Sesión cerrada por inactividad (30 minutos sin actividad).');
      sessionStorage.clear();
      window.location.href = 'admin-login.html';
    }, TIMEOUT_MS);
  }

  ['click','mousemove','keypress','scroll','touchstart'].forEach(evt =>
    document.addEventListener(evt, reiniciar)
  );

  // Iniciar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reiniciar);
  } else {
    reiniciar();
  }
})();

// Exponer en global
window.postJSON = postJSON;
window.mostrarMensaje = mostrarMensaje;
window.cerrarSesion = cerrarSesion;
