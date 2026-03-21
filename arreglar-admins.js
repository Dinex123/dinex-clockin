const bcrypt = require("bcryptjs");
const fs = require("fs");

const a = JSON.parse(fs.readFileSync("admins.json", "utf8"));

a.forEach(x => {
  if (!x.password.startsWith("$2")) {
    x.password = bcrypt.hashSync(x.password, 10);
  }
});

fs.writeFileSync("admins.json", JSON.stringify(a, null, 2));
console.log("admins.json actualizado");
