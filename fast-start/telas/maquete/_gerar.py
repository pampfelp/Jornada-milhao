"""Gera as maquetes do checkout Fast Start (M*.html celular, D*.html computador).
Depois rode _renderizar.py para virar PNG em telas/.
"""
import pathlib

aqui = pathlib.Path(__file__).resolve().parent

HEAD = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="maquete.css?v=1"></head><body>"""

def fundo(pc=False):
    vb = "0 0 1440 900" if pc else "0 0 390 844"
    if pc:
        rotas = """<path class="orbita" d="M-80 760 C 300 620, 760 900, 1520 520"/>
<path class="orbita" d="M-80 820 C 340 690, 800 960, 1520 600"/>
<path class="rota" d="M60 860 C 260 760, 300 600, 520 540 S 900 520, 1040 360 S 1240 120, 1400 70"/>
<path class="rota r2" d="M60 860 C 340 860, 640 720, 820 600 S 1180 330, 1400 70"/>
<circle class="marco" cx="520" cy="540" r="5"/><circle class="marco" cx="1040" cy="360" r="5"/>
<circle class="estrela" cx="1180" cy="520" r="1.6"/><circle class="estrela" cx="980" cy="140" r="1.4"/><circle class="estrela" cx="300" cy="200" r="1.4"/><circle class="estrela" cx="720" cy="90" r="1.8"/>"""
        fog = '<img class="foguete-bg" src="foguete.png" style="right:-40px;top:300px;width:420px" alt="">'
    else:
        rotas = """<path class="orbita" d="M-40 690 C 120 610, 260 760, 430 600"/>
<path class="orbita" d="M-40 740 C 140 660, 280 810, 430 650"/>
<path class="rota" d="M-10 830 C 60 760, 70 660, 150 620 S 290 560, 320 420 S 380 180, 420 120"/>
<path class="rota r2" d="M-10 830 C 120 830, 230 720, 280 620 S 360 300, 420 120"/>
<circle class="marco" cx="150" cy="620" r="4"/><circle class="marco" cx="320" cy="420" r="4"/>
<circle class="estrela" cx="340" cy="250" r="1.4"/><circle class="estrela" cx="60" cy="300" r="1.2"/><circle class="estrela" cx="250" cy="70" r="1.4"/>"""
        fog = '<img class="foguete-bg" src="foguete.png" style="right:-60px;bottom:30px;width:230px" alt="">'
    return f"""<div class="fundo"><div class="malha"></div><div class="brilho b1"></div><div class="brilho b2"></div>
<svg viewBox="{vb}" preserveAspectRatio="xMidYMid slice">{rotas}</svg>{fog}</div>"""

TOPO = """<div class="topo"><img src="logo.png" alt="Fast Start">
<div class="seguro"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Ambiente seguro</div></div>"""

CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
NOMES = ["Empresa", "Responsável", "Contrato", "Pagamento"]

def etapas(atual, trilho=None):
    """atual: índice 0..3 da etapa em andamento; 4 = todas feitas."""
    passo = (346 - 62) / 3  # centro da 1ª bolinha ao centro da última, em 390 px
    w = trilho if trilho is not None else min(atual, 3) * passo
    html = f'<div class="etapas"><div class="trilho" style="width:{w:.0f}px"></div>'
    for i, nome in enumerate(NOMES):
        cls = "feita" if i < atual else ("atual" if i == atual else "")
        dentro = CHECK if i < atual else str(i + 1)
        html += f'<div class="etapa {cls}"><div class="bola">{dentro}</div><div class="nome">{nome}</div></div>'
    return html + "</div>"

SETA = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
VOLTA = '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>'

def campo(rot, val, cls="", tag=""):
    return f'<div class="campo"><label>{rot}</label><div class="in {cls}">{val}{tag}</div></div>'

OKTAG = '<span class="tag"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Encontrado</span>'

def tela(corpo, pc=False):
    return HEAD + fundo(pc) + corpo + "</body></html>"

# ---------------- M01 empresa ----------------
form_empresa = (
    campo("CNPJ", "12.345.678/0001-90", "ok", OKTAG)
    + campo("Razão social", "Sol do Norte Energia Ltda", "ok")
    + '<div class="linha">' + campo("CEP", "66055-100", "ok") + '<div class="campo estreito"><label>Número</label><div class="in foco">216</div></div></div>'
    + campo("Endereço", "Av. Visconde de Souza Franco, Umarizal", "ok")
    + campo("Cidade", "Belém / PA", "ok")
)
m01 = f"""<div class="tela">{TOPO}{etapas(0)}
<div class="cab"><div class="passo">Etapa 1 de 4</div><h1>Vamos começar pela sua empresa</h1>
<p class="sub">Digite o CNPJ e o CEP que a gente completa o resto pra você.</p></div>
<div class="cartao">{form_empresa}</div>
<div class="rodape"><button class="btn prim">Continuar {SETA}</button></div></div>"""

# ---------------- M02 confirmação entre etapas ----------------
faiscas = "".join(f'<span class="faisca" style="left:{x}px;top:{y}px;opacity:{o};transform:scale({s})"></span>'
                  for x, y, o, s in [(4, 30, .9, 1), (100, 8, .7, .8), (112, 82, .8, 1.1), (-6, 92, .5, .7), (56, -14, .6, .9)])
m02 = f"""<div class="tela">{TOPO}{etapas(1, trilho=60)}
<div class="cab"><div class="passo">Etapa 1 de 4</div><h1>Vamos começar pela sua empresa</h1></div>
<div class="cartao">{form_empresa}</div></div>
<div class="veu"><div class="confirma"><div class="selo">{CHECK}{faiscas}</div>
<h2>Empresa registrada</h2>
<p>A Sol do Norte já está no nosso radar. Agora falta conhecer quem vai conduzir a aceleração aí dentro.</p>
<div class="prox">Próximo: Responsável <i></i></div></div></div>"""

# ---------------- M03 responsável ----------------
m03 = f"""<div class="tela">{TOPO}{etapas(1)}
<div class="cab"><div class="passo">Etapa 2 de 4</div><h1>Quem representa a empresa?</h1>
<p class="sub">É essa pessoa que assina o contrato e participa dos encontros.</p></div>
<div class="cartao">{campo("Nome completo", "Mariana Costa Albuquerque", "ok")}{campo("CPF", "123.456.789-00", "ok")}
{campo("E-mail", "mariana@soldonorte.com.br", "ok")}{campo("WhatsApp", "(91) 9 8123-4567", "foco")}</div>
<div class="rodape"><button class="btn sec">{VOLTA}</button><button class="btn prim">Continuar {SETA}</button></div></div>"""

# ---------------- M04 contrato ----------------
def ic(path):
    return f'<div class="ic"><svg viewBox="0 0 24 24">{path}</svg></div>'
I_CAL = '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'
I_GRUPO = '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.8.3 5 2.6 5 5.8"/>'
I_VOLTA = '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/>'
I_DOC = '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'
m04 = f"""<div class="tela">{TOPO}{etapas(2)}
<div class="cab"><div class="passo">Etapa 3 de 4</div><h1>Seu contrato, já preenchido</h1></div>
<div class="cartao"><div class="resumo">
<div class="item">{ic(I_CAL)}<div><b>3 meses de programa</b><span>Começa na data que a equipe informar na inscrição.</span></div></div>
<div class="item">{ic(I_GRUPO)}<div><b>Encontros semanais em grupo</b><span>Online e ao vivo: time de vendas, funil e proposta comercial.</span></div></div>
<div class="item">{ic(I_VOLTA)}<div><b>7 dias para desistir</b><span>Devolução integral, se você não tiver participado de nenhum encontro.</span></div></div>
</div>
<div class="ler"><svg viewBox="0 0 24 24">{I_DOC}</svg>Ler termos e condições</div>
<div class="partes"><div class="parte"><small>CONTRATADO</small><b>Benedito João Viegas de Matos</b><em>{CHECK}Assinado</em></div>
<div class="parte pendente"><small>CONTRATANTE</small><b>Sol do Norte Energia Ltda</b><em>Assina ao aceitar</em></div></div>
<div class="aceite"><div class="caixa">{CHECK}</div><div><p>Li e aceito os <u>termos e condições</u> do contrato Fast Start.</p>
<small>Seu aceite vale como assinatura eletrônica. Registramos data, hora e IP, e a cópia assinada vai para mariana@soldonorte.com.br.</small></div></div>
</div>
<div class="rodape"><button class="btn sec">{VOLTA}</button><button class="btn prim">Aceitar e continuar {SETA}</button></div></div>"""

# ---------------- M05 pagamento ----------------
I_PIX = '<path d="M12 3l9 9-9 9-9-9z"/><path d="M8.5 12h7"/>'
I_CARD = '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>'
SETA_B = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>'
CAD = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
m05 = f"""<div class="tela">{TOPO}{etapas(3)}
<div class="cab"><div class="passo">Etapa 4 de 4</div><h1>Último passo pra garantir sua vaga</h1></div>
<div class="cartao"><div class="preco"><small>Investimento Fast Start</small><b>R$ 4.997,00</b></div>
<div class="opcoes">
<div class="opcao on"><div class="radio"></div><div class="txt"><b>Cartão de crédito</b><span>Em até 12x sem juros</span></div><div class="ico"><svg viewBox="0 0 24 24">{I_CARD}</svg></div></div>
<div class="opcao"><div class="radio"></div><div class="txt"><b>Pix</b><span>À vista, aprovação na hora</span></div><div class="ico"><svg viewBox="0 0 24 24">{I_PIX}</svg></div></div>
</div>
<div class="parcelas"><span>Parcelas</span>12x sem juros{SETA_B}</div>
</div>
<div class="rodape coluna"><button class="btn prim">{CAD} Pagar com PicPay</button>
<div class="picpay">{CAD}Os dados do cartão são digitados na janela da PicPay e não passam pelo nosso site.</div></div></div>"""

# ---------------- M06 confirmado ----------------
m06 = f"""<div class="tela">{TOPO}{etapas(4)}
<div class="final"><img class="foguete-grande" src="foguete.png" alt="">
<h1>Vaga garantida, Mariana</h1>
<p class="sub">A Sol do Norte agora faz parte da próxima turma do Fast Start. O pagamento foi confirmado e o contrato está assinado pelas duas partes.</p>
<div class="cartao passos">
<div class="item"><div class="n">1</div><div><b>Contrato no seu e-mail</b><span>A cópia assinada chegou em mariana@soldonorte.com.br.</span></div></div>
<div class="item"><div class="n">2</div><div><b>Data de início</b><span>Nossa equipe chama você no WhatsApp com a data da turma.</span></div></div>
<div class="item"><div class="n">3</div><div><b>Plataforma de gestão financeira</b><span>O acesso é liberado junto com o primeiro encontro.</span></div></div>
</div></div></div>"""

# ---------------- D01 computador, etapa 1 ----------------
d01 = f"""<div class="pc"><div class="topo-pc"><img src="logo.png" alt="Fast Start"></div>
<div class="esq"><div class="chip">INSCRIÇÃO · PRÓXIMA TURMA</div>
<h1>Estruture o comercial da sua empresa em <em>3 meses</em></h1>
<p class="sub">Do recrutamento do time de vendas às estratégias de fechamento, em encontros semanais ao vivo com outras empresas do setor.</p>
<div class="resumo">
<div class="item">{ic(I_GRUPO)}<div><b>Terças: time de vendas</b><span>Recrutamento, treinamento e acompanhamento de vendedores.</span></div></div>
<div class="item">{ic(I_CAL)}<div><b>Quintas: funil e proposta</b><span>Funil comercial, canais de aquisição e apresentação de proposta.</span></div></div>
<div class="item">{ic(I_DOC)}<div><b>Bônus: gestão financeira</b><span>Acesso à plataforma durante todo o programa.</span></div></div>
</div>
<div class="preco-pc"><b>R$ 4.997,00</b><span>ou em até 12x sem juros no cartão</span></div></div>
<div class="dir"><div class="painel">{etapas(0)}
<div class="cab"><div class="passo">Etapa 1 de 4</div><h1>Vamos começar pela sua empresa</h1>
<p class="sub">Digite o CNPJ e o CEP que a gente completa o resto pra você.</p></div>
<div class="cartao" style="margin-top:16px">{form_empresa}</div>
<div class="rodape"><button class="btn prim">Continuar {SETA}</button></div></div></div></div>"""

# ================= opção 1: assinatura na Autentique =================
I_CANETA = '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>'
resumo_contrato = f"""<div class="resumo">
<div class="item">{ic(I_CAL)}<div><b>3 meses de programa</b><span>Começa na data que a equipe informar na inscrição.</span></div></div>
<div class="item">{ic(I_GRUPO)}<div><b>Encontros semanais em grupo</b><span>Online e ao vivo: time de vendas, funil e proposta comercial.</span></div></div>
<div class="item">{ic(I_VOLTA)}<div><b>7 dias para desistir</b><span>Devolução integral, se você não tiver participado de nenhum encontro.</span></div></div>
</div>"""

m04a = f"""<div class="tela">{TOPO}{etapas(2)}
<div class="cab"><div class="passo">Etapa 3 de 4</div><h1>Seu contrato, já preenchido</h1></div>
<div class="cartao">{resumo_contrato}
<div class="partes"><div class="parte"><small>CONTRATADO</small><b>Benedito João Viegas de Matos</b><em>{CHECK}Assinado</em></div>
<div class="parte pendente"><small>CONTRATANTE</small><b>Sol do Norte Energia Ltda</b><em>Falta a sua assinatura</em></div></div>
<div class="selo-aut"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>
<p>A assinatura é feita pela <b>Autentique</b>, com validade jurídica. Leva menos de um minuto e você não sai desta página.</p></div>
</div>
<div class="rodape"><button class="btn sec">{VOLTA}</button><button class="btn prim"><svg viewBox="0 0 24 24">{I_CANETA}</svg>Assinar contrato</button></div></div>"""

m04b = f"""<div class="tela">{TOPO}{etapas(2)}
<div class="cab"><div class="passo">Etapa 3 de 4</div><h1>Seu contrato, já preenchido</h1></div></div>
<div class="veu claro"></div>
<div class="folha">
<div class="rep">REPRESENTAÇÃO · a tela real é da Autentique</div>
<div class="aut"><div class="aut-top"><b>Autentique</b><span class="x">&times;</span></div>
<div class="aut-doc"><div class="pg"><i></i><i></i><i class="c"></i><i></i><i class="c"></i><i></i></div>
<div class="aut-doc-txt"><b>Contrato Fast Start - Sol do Norte Energia Ltda</b><span>7 páginas · enviado por Jornada do Milhão</span><u>Visualizar documento</u></div></div>
<div class="aut-campo"><label>Nome completo</label><div>Mariana Costa Albuquerque</div></div>
<div class="aut-linha"><div class="aut-campo"><label>CPF</label><div>123.456.789-00</div></div>
<div class="aut-campo"><label>Data de nascimento</label><div class="vazio">dd/mm/aaaa</div></div></div>
<div class="aut-btn">Assinar</div>
<div class="aut-nota">Ao assinar, você concorda com os termos do documento.</div></div></div>"""

m04c = f"""<div class="tela">{TOPO}{etapas(3, trilho=150)}
<div class="cab"><div class="passo">Etapa 3 de 4</div><h1>Seu contrato, já preenchido</h1></div>
<div class="cartao">{resumo_contrato}</div></div>
<div class="veu"><div class="confirma"><div class="selo">{CHECK}{faiscas}</div>
<h2>Contrato assinado</h2>
<p>Pronto, Mariana. As duas assinaturas estão registradas na Autentique e a cópia vai para o seu e-mail. Só falta garantir a vaga.</p>
<div class="prox">Próximo: Pagamento <i></i></div></div></div>"""

# ================= pagamento com campos no nosso site (SDK PicPay) =================
abas = lambda on: f"""<div class="abas"><div class="aba {'on' if on=='cartao' else ''}"><svg viewBox="0 0 24 24">{I_CARD}</svg>Cartão</div>
<div class="aba {'on' if on=='pix' else ''}"><svg viewBox="0 0 24 24">{I_PIX}</svg>Pix</div></div>"""

BAND = '<span class="band">VISA</span>'
m05a = f"""<div class="tela">{TOPO}{etapas(3)}
<div class="cab compacto"><div class="passo">Etapa 4 de 4</div><h1>Último passo pra garantir sua vaga</h1></div>
<div class="cartao denso"><div class="preco"><small>Investimento Fast Start</small><b>R$ 4.997,00</b></div>
{abas('cartao')}
{campo("Número do cartão", "4111 1111 1111 1111", "ok", BAND)}
{campo("Nome impresso no cartão", "MARIANA C ALBUQUERQUE", "ok")}
<div class="linha">{campo("Validade", "08/29", "ok")}{campo("CVV", "•••", "foco")}</div>
{campo("CPF do titular", "123.456.789-00", "ok")}
<div class="campo"><label>Parcelas</label><div class="parcelas" style="margin-top:0">12x sem juros{SETA_B}</div></div>
</div>
<div class="rodape coluna"><button class="btn prim">{CAD} Pagar R$ 4.997,00</button>
<div class="picpay">{CAD}Processado pela PicPay. O cartão não fica no nosso site.</div></div></div>"""

m05b = f"""<div class="tela">{TOPO}{etapas(3)}
<div class="cab compacto"><div class="passo">Etapa 4 de 4</div><h1>Último passo pra garantir sua vaga</h1></div>
<div class="cartao"><div class="preco"><small>Investimento Fast Start</small><b>R$ 4.997,00</b></div>
{abas('pix')}
<div class="qr"><div class="qr-img"></div></div>
<div class="copia"><span>00020126580014br.gov.bcb.pix0136a1f4...</span><b>Copiar</b></div>
<div class="espera"><span class="pulso"></span>Aguardando o pagamento. Esta tela atualiza sozinha.</div>
</div>
<div class="rodape coluna"><div class="picpay" style="margin-top:0">{CAD}Pagamento processado pela PicPay.</div></div></div>"""

# ================= aviso de demonstração, rodapé e privacidade =================
FAIXA = """<div class="faixa-demo"><span class="ponto"></span>Ambiente de demonstração: nada do que você preencher é gravado ou cobrado.</div>"""

m07a = FAIXA + m01.replace('<div class="tela">', '<div class="tela com-faixa">', 1)

RODAPE = """<footer class="rodape-site">
<img src="logo.png" alt="Fast Start" class="rs-logo">
<p>Fast Start, um programa da Jornada do Milhão.<br>Belém / PA</p>
<nav><u>Termos do contrato</u><u>Privacidade</u><u>Fale com a gente</u></nav>
<small>Pagamentos processados pela PicPay. Assinatura eletrônica pela Autentique.</small>
</footer>"""
m07b = f"""<div class="tela rolada"><div class="cartao" style="margin-top:0">{form_empresa.replace(' foco', ' ok')}</div>
<div class="rodape" style="margin-top:14px"><button class="btn prim">Continuar {SETA}</button></div>
{RODAPE}</div>"""

VOLTA_TXT = f'<span class="voltar-link">{VOLTA}Voltar à inscrição</span>'
m08 = f"""<div class="tela doc"><div class="topo"><img src="logo.png" alt="Fast Start"></div>
{VOLTA_TXT}
<div class="passo" style="margin-top:22px">Atualizada em 20/10/2026</div>
<h1>Política de privacidade</h1>
<p class="lead">Explicamos aqui, sem juridiquês, o que fazemos com os dados que você informa na inscrição do Fast Start.</p>
<h3>Quem cuida dos seus dados</h3>
<p>O programa Fast Start é conduzido por Benedito João Viegas de Matos, em Belém/PA, responsável pelo tratamento dos dados. Contato: [e-mail a definir].</p>
<h3>O que coletamos</h3>
<p>Da empresa: CNPJ, razão social e endereço. De quem representa: nome, CPF, e-mail e WhatsApp. Os dados do cartão são digitados direto no sistema da PicPay e não ficam com a gente.</p>
<h3>Para que usamos</h3>
<p>Para preencher e assinar o contrato, cobrar o investimento, emitir documentos e falar com você sobre o programa.</p></div>"""

for nome, corpo, pc in [("M01-empresa", m01, False), ("M02-confirmado-etapa", m02, False), ("M03-responsavel", m03, False),
                        ("M04-contrato", m04, False), ("M05-pagamento", m05, False), ("M06-vaga-garantida", m06, False),
                        ("M04a-assinar-autentique", m04a, False), ("M04b-janela-autentique", m04b, False),
                        ("M04c-contrato-assinado", m04c, False), ("M05a-cartao", m05a, False), ("M05b-pix", m05b, False),
                        ("M07a-aviso-demonstracao", m07a, False), ("M07b-rodape", m07b, False), ("M08-privacidade", m08, False),
                        ("D01-empresa-computador", d01, True)]:
    (aqui / f"{nome}.html").write_text(tela(corpo, pc), encoding="utf-8")
    print("ok", nome)
