"""Lista (e, com --apagar, apaga) o que o checkout do Fast Start criou em teste.

Só entra o que é inequivocamente teste:
  - inscricoesFastStart com ambiente "sandbox";
  - clientes com nome terminando em " (TESTE)" e origem "Checkout Fast Start (TESTE)";
  - agendamentos com clienteNome terminando em " (TESTE)" e observação do checkout;
  - tarefas "Fast Start pago: ... (TESTE)".
Os PDFs de teste na pasta de contratos do Drive não entram (apague lá).

Uso, de dentro de Projetos/:
  python JornadaMilhao/fast-start/ferramentas/limpar_testes.py ChavesAPI/<conta-de-servico>.json
  python JornadaMilhao/fast-start/ferramentas/limpar_testes.py ChavesAPI/<conta-de-servico>.json --apagar
"""
import sys
import google.auth.transport.requests
from google.oauth2 import service_account

PROJETO = "financeirojornadamilhao"
B = f"https://firestore.googleapis.com/v1/projects/{PROJETO}/databases/(default)/documents"

cred = service_account.Credentials.from_service_account_file(sys.argv[1], scopes=["https://www.googleapis.com/auth/datastore"])
s = google.auth.transport.requests.AuthorizedSession(cred)
apagar = "--apagar" in sys.argv


def todos(colecao):
    docs, token = [], None
    while True:
        url = f"{B}/{colecao}?pageSize=300" + (f"&pageToken={token}" if token else "")
        r = s.get(url).json()
        docs += r.get("documents", [])
        token = r.get("nextPageToken")
        if not token:
            return docs


def campo(doc, nome):
    v = doc.get("fields", {}).get(nome, {})
    return v.get("stringValue", "")


alvos = []
for d in todos("inscricoesFastStart"):
    if campo(d, "ambiente") == "sandbox":
        alvos.append(("inscrição", campo(d, "razaoSocial"), d["name"]))
for d in todos("clientes"):
    if campo(d, "nome").endswith(" (TESTE)") and campo(d, "origem") == "Checkout Fast Start (TESTE)":
        alvos.append(("cliente", campo(d, "nome"), d["name"]))
for d in todos("agendamentos"):
    if campo(d, "clienteNome").endswith(" (TESTE)") and campo(d, "observacoes").startswith("Checkout Fast Start:"):
        alvos.append(("card", campo(d, "clienteNome"), d["name"]))
for d in todos("tarefas"):
    t = campo(d, "titulo")
    if t.startswith("Fast Start pago:") and t.endswith("(TESTE)"):
        alvos.append(("tarefa", t, d["name"]))

for tipo, nome, caminho in alvos:
    print(f"{tipo:10} {nome[:60]:60} {caminho.split('/documents/')[1]}")
print(f"\n{len(alvos)} registro(s) de teste.")

if apagar:
    for tipo, nome, caminho in alvos:
        r = s.delete(f"https://firestore.googleapis.com/v1/{caminho}")
        print("apagado" if r.status_code == 200 else f"falhou {r.status_code}", caminho.split("/documents/")[1])
else:
    print("Nada foi apagado. Rode de novo com --apagar pra apagar exatamente esta lista.")
