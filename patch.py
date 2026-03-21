content = open("server.js", "r", encoding="utf-8").read()
patch = "\nconst adminExists = db.prepare(\"SELECT * FROM usuarios WHERE usuario = \047Dinex\047\").get();\nif (!adminExists) {\n  const hashAdmin = crypto.scryptSync(\047Admin2026\044\047, \047salt\047, 64).toString(\047hex\047);\n  db.prepare(\"INSERT INTO usuarios (usuario, password, rol) VALUES (?, ?, ?)\").run(\047Dinex\047, hashAdmin, \047admin\047);\n  console.log(\047Admin creado\047);\n}\n"
content = content.replace("const db = new sqlite3.Database(PATHS.dbFile);", "const db = new sqlite3.Database(PATHS.dbFile);" + patch)
open("server.js", "w", encoding="utf-8").write(content)
print("Listo!")
