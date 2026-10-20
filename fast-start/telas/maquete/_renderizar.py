"""Renderiza as maquetes em telas/<nome>.png.
M*.html: celular 390 x 844 (num iframe de 390 px, porque o Chrome headless no
Windows não abre janela menor que ~500 px). D*.html: computador 1440 x 900.
Uso: python _renderizar.py [M01-empresa.html ...]
"""
import pathlib, subprocess, sys
from PIL import Image

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
aqui = pathlib.Path(__file__).resolve().parent
saida = aqui.parent
nomes = sys.argv[1:] or sorted(p.name for p in aqui.glob("[MD]*.html"))
for nome in nomes:
    png = saida / (pathlib.Path(nome).stem + ".png")
    if nome.startswith("D"):
        subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--virtual-time-budget=6000",
                        "--force-device-scale-factor=1", "--window-size=1440,900",
                        f"--screenshot={png}", (aqui / nome).as_uri()], check=True, capture_output=True)
    else:
        url = (aqui / "_quadro390.html").as_uri() + "#" + nome
        subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--virtual-time-budget=6000",
                        "--force-device-scale-factor=2", "--window-size=500,900",
                        f"--screenshot={png}", url], check=True, capture_output=True)
        Image.open(png).crop((0, 0, 780, 1688)).save(png)
    print("ok", png.name)
