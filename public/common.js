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
    localStorage.removeItem('usuario');
    localStorage.removeItem('departamento');
    sessionStorage.clear();
  } finally {
    window.location.href = 'usuario-login.html';
  }
}

// Exponer en global
window.postJSON = postJSON;
window.mostrarMensaje = mostrarMensaje;
window.cerrarSesion = cerrarSesion;
