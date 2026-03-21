const adminExists = db.prepare("SELECT * FROM usuarios WHERE usuario = 'Dinex'").get();
if (!adminExists) {
  const hashAdmin = crypto.scryptSync('Admin2026$', 'salt', 64).toString('hex');
  db.prepare("INSERT INTO usuarios (usuario, password, rol) VALUES (?, ?, ?)").run('Dinex', hashAdmin, 'admin');
  console.log('Admin creado');
}
