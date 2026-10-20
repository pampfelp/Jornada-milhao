"""Renderiza cada estado do checkout (servidor local na porta 8747, raiz em
JornadaMilhao) e monta a comparação lado a lado com a imagem validada.
Saída: telas/esqueleto/<estado>.png e telas/esqueleto/_comparacao-<estado>.png
Uso: python _esqueleto.py [pasta-de-saída] [pagina.html]
"""
import pathlib, subprocess, sys
from PIL import Image

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PAGINA = sys.argv[2] if len(sys.argv) > 2 else ""
EXTRA = "&exemplo=1" if "--exemplo" in sys.argv else ""
BASE = "http://localhost:8747/fast-start/"
aqui = pathlib.Path(__file__).resolve().parent
saida = aqui / (sys.argv[1] if len(sys.argv) > 1 else "esqueleto")
saida.mkdir(exist_ok=True)

CELULAR = [("empresa", "M01-empresa"), ("confirma-1", "M02-confirmado-etapa"), ("responsavel", "M03-responsavel"),
           ("contrato", "M04a-assinar-autentique"), ("autentique", "M04b-janela-autentique"),
           ("contrato-assinado", "M04c-contrato-assinado"), ("cartao", "M05a-cartao"), ("pix", "M05b-pix"),
           ("final", "M06-vaga-garantida")]

def chrome(url, png, janela, escala):
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--virtual-time-budget=4000",
                    f"--force-device-scale-factor={escala}", f"--window-size={janela}",
                    f"--screenshot={png}", url], check=True, capture_output=True)

def comparar(imagem, esqueleto, destino):
    a, b = Image.open(imagem).convert("RGB"), Image.open(esqueleto).convert("RGB")
    b = b.resize(a.size)
    c = Image.new("RGB", (a.width * 2 + 20, a.height), "white")
    c.paste(a, (0, 0)); c.paste(b, (a.width + 20, 0))
    c.save(destino)

for estado, imagem in CELULAR:
    png = saida / f"{estado}.png"
    chrome(BASE + "telas/maquete/_quadro390.html#" + BASE + PAGINA + "?estado=" + estado + EXTRA, png, "500,900", 2)
    Image.open(png).crop((0, 0, 780, 1688)).save(png)
    comparar(aqui / f"{imagem}.png", png, saida / f"_comparacao-{estado}.png")
    print("ok", estado)

png = saida / "computador-empresa.png"
chrome(BASE + PAGINA + "?estado=empresa" + EXTRA, png, "1440,900", 1)
comparar(aqui / "D01-empresa-computador.png", png, saida / "_comparacao-computador-empresa.png")
print("ok computador-empresa")
