import base64
data = open("b64.txt").read().strip()
open("public/corregir.html","wb").write(base64.b64decode(data))
print("Archivo escrito!")
