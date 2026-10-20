// Contato público do Fast Start, num lugar só (rodapé e privacidade leem daqui).
const CONTATO = {
  email: "m1lhaodajornada@gmail.com",
  whatsapp: "5591993567910",
  whatsappTexto: "(91) 99356-7910"
};

document.querySelectorAll('[data-contato="email"]').forEach((a) => {
  a.href = `mailto:${CONTATO.email}`;
  a.textContent = CONTATO.email;
});
document.querySelectorAll('[data-contato="whatsapp"]').forEach((a) => {
  a.href = `https://wa.me/${CONTATO.whatsapp}?text=${encodeURIComponent("Olá! Tenho uma dúvida sobre a inscrição no Fast Start.")}`;
  a.target = "_blank";
  a.rel = "noopener";
});
