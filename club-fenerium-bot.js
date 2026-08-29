const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ─── ENV ────────────────────────────────────────────────────────────────────
// Bunları hosting panelinde (Render/Railway/vb.) Environment Variables olarak
// gir. Kod içine gerçek anahtarları YAZMA — burada sadece env yoksa diye
// (test amaçlı) örnek Telegram bilgilerin fallback olarak duruyor.
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN       || 'clubfenerium2026';
const CLAUDE_API_KEY     = process.env.CLAUDE_API_KEY;
const IG_ACCESS_TOKEN    = process.env.IG_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8622803496:AAFniRzZmZjA0Kx5NrxvWOCGbLeYC61FqSA';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '-5162249924';

// ─── ÜRÜN (TEK ÜRÜN) ────────────────────────────────────────────────────────
const URUN_ADI = 'CLUB FENERIUM ÉDİTİON OR FORMASI';
const BIRIM_FIYAT = 850; // TL
const POS_BEDELI = 50;   // Kartla ödemede ek hizmet bedeli
const BEDENLER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

const URUN_GORSELLERI = [
  'https://res.cloudinary.com/dtqb6ruqj/image/upload/v1787942765/IMG_3230_t6ljhe.jpg', // ön
  'https://res.cloudinary.com/dtqb6ruqj/image/upload/v1787942765/IMG_3241_hxh55z.jpg', // arka
  'https://res.cloudinary.com/dtqb6ruqj/image/upload/v1787942767/IMG_3245_zhttvv.jpg', // nakış detay
  'https://res.cloudinary.com/dtqb6ruqj/image/upload/v1787942766/IMG_3243_q7iaba.jpg', // kumaş detay
];

const VITRIN_METNI =
  URUN_ADI + '\n\n' +
  '1 Adet: 850₺\n' +
  '2 Adet: 1.650₺ (50₺ indirimli)\n' +
  '3 Adet ve üzeri: adet × 850₺ − 100₺\n\n' +
  'Kapıda Ödeme — Nakit veya Kart (Kart ile +50₺ POS hizmet bedeli)\n' +
  '2-4 iş günü içinde teslimat 🙏🏻';

// Adet bazlı toplam tutarı hesaplar (indirim + varsa POS bedeli dahil)
function toplamHesapla(adet, odemeYontemi) {
  const n = Math.max(1, parseInt(adet, 10) || 1);
  let indirim = 0;
  if (n === 2) indirim = 50;
  else if (n >= 3) indirim = 100;
  const posBedeli = odemeYontemi === 'kart' ? POS_BEDELI : 0;
  const toplam = (n * BIRIM_FIYAT) - indirim + posBedeli;
  return { adet: n, indirim, posBedeli, toplam };
}

// ─── VARYASYON METİNLERİ (bilgi hep aynı, kelimeler her seferinde değişsin) ──
const KART_UYARI_VARYASYONLAR = [
  'Kartla ödemede kargo firması POS Cihazı Hizmet Bedeli olarak +50₺ ekstra ücret alıyor. Nakit ödeme sizin için daha avantajlı olur.',
  'Kart ile ödemede +50₺ POS Cihazı Hizmet Bedeli yansıyor. Nakit seçerseniz bu ek ücret olmaz.',
  'Kartla ödemelerde kargo +50₺ POS bedeli kesiyor efendim, nakit tercih ederseniz bu ücret çıkmaz.',
];
function kartUyariMesaji() { return sec(KART_UYARI_VARYASYONLAR); }

const WHATSAPP_KANAL_LINKI = ''; // istersen WhatsApp kanal linkini buraya ekle
const SIPARIS_SONRASI_VARYASYONLAR = [
  'Siparişiniz alınmıştır, teşekkür ederiz 🙏🏻 Kısa süre içinde sizi arayarak teyit alacağız.',
  'Siparişiniz bize ulaştı, teşekkürler 🙏🏻 Onay için birazdan sizi arayacağız.',
  'Siparişinizi aldık, teşekkür ederiz 🙏🏻 Teyit için kısa süre içinde ulaşacağız.',
];
function siparisSonrasiMesaj() { return sec(SIPARIS_SONRASI_VARYASYONLAR); }

// ─── YARDIMCI FONKSİYONLAR ──────────────────────────────────────────────────
function bekle(ms) { return new Promise(r => setTimeout(r, ms)); }
function rastgeleBekle(minSn, maxSn) {
  const ms = (Math.random() * (maxSn - minSn) + minSn) * 1000;
  return bekle(Math.round(ms));
}
function sec(varyasyonlar) { return varyasyonlar[Math.floor(Math.random() * varyasyonlar.length)]; }

function kartVar(m) {
  return ['kart', 'kard', 'kartla', 'karta', 'kredi'].some(k => m.toLowerCase().includes(k));
}

function anlamsizMi(txt) {
  const t = txt.trim();
  if (!t) return true;
  if (/^[.…\s😊👍❤️🙏]+$/.test(t)) return true;
  if (t.length < 2) return true;
  return false;
}

function siparisGecerliMi(siparis) {
  const zorunlu = ['ad_soyad', 'telefon', 'il', 'ilce', 'adres', 'beden', 'adet', 'odeme', 'toplam'];
  const eksikler = zorunlu.filter(k => !siparis[k] || String(siparis[k]).trim() === '');
  return { gecerli: eksikler.length === 0, eksikler };
}

function siparisiParsEt(metin) {
  const m = metin.match(/###SIPARIS_BASLA###([\s\S]*?)###SIPARIS_BITIS###/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch (e) {
    console.error('SİPARİŞ JSON PARSE HATASI:', e.message);
    return { __parseHatasi: true, __hamMetin: m[1].trim() };
  }
}

// ─── TELEGRAM BİLDİRİMİ ─────────────────────────────────────────────────────
async function telegramGonderHam(hamMetin, deneme = 0) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const msg = '⚠️ SİPARİŞ FORMATI BOZUK — MANUEL KONTROL GEREKİYOR!\n\n' + hamMetin;
    await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      chat_id: TELEGRAM_CHAT_ID, text: msg, disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('Telegram ham gönderim err:', e.message);
    if (deneme < 2) { await bekle(3000); return telegramGonderHam(hamMetin, deneme + 1); }
  }
}

async function telegramGonder(siparis, deneme = 0) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const telefonRakam = (siparis.telefon || '').replace(/\D/g, '').replace(/^90/, '').replace(/^0/, '');
    const telefonUyari = telefonRakam.length !== 10 ? ' ⚠️EKSİK' : '';
    const odemeMetin = siparis.odeme === 'kart' ? 'KART (Kapıda POS, +50₺)' : 'NAKİT (Kapıda)';
    const toplamTemiz = String(siparis.toplam || '').replace(/\s*(TL|₺)\s*$/i, '').trim();

    const msg =
      '📦 YENİ SİPARİŞ — Club Fenerium\n' +
      '━━━━━━━━━━━━━━━\n\n' +
      '👤 ' + siparis.ad_soyad.toUpperCase() + '\n' +
      '📞 ' + siparis.telefon + telefonUyari + '\n' +
      '📍 ' + siparis.il + ' / ' + siparis.ilce + '\n' +
      '🏠 ' + siparis.adres + '\n\n' +
      '👕 ' + URUN_ADI + '\n' +
      '📐 Beden: ' + siparis.beden + '\n' +
      '🔢 Adet: ' + siparis.adet + '\n' +
      '💳 Ödeme: ' + odemeMetin + '\n' +
      (siparis.not ? '📝 Not: ' + siparis.not + '\n' : '') +
      '\n💰 TOPLAM: ' + toplamTemiz + '₺';

    await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      chat_id: TELEGRAM_CHAT_ID, text: msg, disable_web_page_preview: true,
    });
    console.log('Telegram gönderildi ✓');
  } catch (e) {
    console.error('Telegram err:', e.message);
    if (deneme < 2) { await bekle(3000); return telegramGonder(siparis, deneme + 1); }
  }
}

// ─── STATE (bellek içi — sunucu yeniden başlarsa sıfırlanır) ───────────────
// Not: Kalıcı olmasını istersen (restart sonrası da hatırlasın), basit bir
// dosya/DB (ör. SQLite, Turso, Redis) eklenebilir — istersen sonradan ekleriz.
const kullanicilar = {};       // { [id]: { gorselGitti, kartUyariGitti, konusmalar:[], siparisVerildi, siparisTarihi } }
const islemDurumu = {};        // { [id]: { mesgulMu, bekleyenler:[], timer } }
const floodKoruma = {};        // { [id]: { sayac, ilkZaman, engellendi } }
const BIR_GUN_SANIYE = 24 * 60 * 60;
const BES_GUN_SANIYE = 5 * 24 * 60 * 60;

function kullaniciAl(id) {
  const simdi = Math.floor(Date.now() / 1000);
  if (!kullanicilar[id]) {
    kullanicilar[id] = { gorselGitti: false, kartUyariGitti: false, konusmalar: [], siparisVerildi: false, siparisTarihi: 0, sonMesaj: simdi };
  }
  const u = kullanicilar[id];
  // Sipariş verilmişse 5 gün boyunca görselleri tekrar göndermeyiz ama konuşmaya devam ederiz
  if (u.siparisVerildi && (simdi - u.siparisTarihi) > BES_GUN_SANIYE) {
    kullanicilar[id] = { gorselGitti: false, kartUyariGitti: false, konusmalar: [], siparisVerildi: false, siparisTarihi: 0, sonMesaj: simdi };
  }
  // Sipariş verilmedi ve 24 saattir sessizse sıfırla (yeni sohbet gibi karşıla)
  if (!u.siparisVerildi && (simdi - u.sonMesaj) > BIR_GUN_SANIYE && u.gorselGitti) {
    kullanicilar[id] = { gorselGitti: false, kartUyariGitti: false, konusmalar: [], siparisVerildi: false, siparisTarihi: 0, sonMesaj: simdi };
  }
  u.sonMesaj = simdi;
  return kullanicilar[id];
}

function islemDurumuAl(id) {
  if (!islemDurumu[id]) islemDurumu[id] = { mesgulMu: false, bekleyenler: [], timer: null };
  return islemDurumu[id];
}

function floodKontrol(id) {
  const simdi = Date.now();
  if (!floodKoruma[id]) floodKoruma[id] = { sayac: 0, ilkZaman: simdi, engellendi: false };
  const f = floodKoruma[id];
  if (f.engellendi && (simdi - f.ilkZaman) > 10 * 60 * 1000) { floodKoruma[id] = { sayac: 1, ilkZaman: simdi, engellendi: false }; return false; }
  if (f.engellendi) return true;
  if ((simdi - f.ilkZaman) > 10 * 1000) { floodKoruma[id] = { sayac: 1, ilkZaman: simdi, engellendi: false }; return false; }
  f.sayac++;
  if (f.sayac >= 5) { f.engellendi = true; f.ilkZaman = simdi; return true; }
  return false;
}

// Müşteri art arda yazarken toplu işlemek için bekleme süresi
const MESAJ_BEKLEME_MS = 8000;
function yenidenPlanla(id) {
  const durum = islemDurumuAl(id);
  if (durum.bekleyenler.length === 0) return;
  if (durum.timer) clearTimeout(durum.timer);
  durum.timer = setTimeout(async () => { durum.timer = null; await isle(id); }, MESAJ_BEKLEME_MS);
}

// ─── INSTAGRAM GRAPH API ────────────────────────────────────────────────────
let sonGonderimMs = 0;
let gonderimKuyrugu = Promise.resolve();
function kuyruklaGonder(gonderFn) {
  gonderimKuyrugu = gonderimKuyrugu.then(async () => {
    const simdi = Date.now();
    const gecenMs = simdi - sonGonderimMs;
    const minAralikMs = Math.round((1.2 + Math.random() * 1.8) * 1000);
    if (gecenMs < minAralikMs) await bekle(minAralikMs - gecenMs);
    sonGonderimMs = Date.now();
    try { await gonderFn(); } catch (e) { console.error('Gönderim hatası:', e.response?.data || e.message); }
  });
  return gonderimKuyrugu;
}

async function igMesaj(id, metin) {
  await kuyruklaGonder(() => axios.post(
    'https://graph.instagram.com/v25.0/me/messages',
    { recipient: { id }, message: { text: metin } },
    { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  ));
}

async function igGorsel(id, url) {
  await kuyruklaGonder(() => axios.post(
    'https://graph.instagram.com/v25.0/me/messages',
    { recipient: { id }, message: { attachment: { type: 'image', payload: { url, is_reusable: true } } } },
    { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  ));
}

async function yorumuCevapla(yorumId, metin) {
  await kuyruklaGonder(() => axios.post(
    'https://graph.instagram.com/v25.0/' + yorumId + '/replies',
    { message: metin },
    { headers: { Authorization: 'Bearer ' + IG_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
  ));
}

const YORUM_VARYASYONLAR = [
  'Merhaba, detaylı bilgi için bize özelden yazabilirsiniz 🙏🏻',
  'Merhaba, fiyat ve sipariş için özelden yazmanız yeterli 🙏🏻',
  'Merhaba, size özelden yardımcı olabiliriz, yazmanız yeterli 🙏🏻',
];

// ─── CLAUDE API ─────────────────────────────────────────────────────────────
async function claude(mesajlar) {
  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system: PROMPT, messages: mesajlar },
      { headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );
    return r.data.content[0].text;
  } catch (e) {
    console.error('Claude err:', e.response?.data || e.message);
    return 'Şu an teknik bir sorun var, birazdan tekrar yazabilirsiniz.';
  }
}

// ─── SİSTEM PROMPT (TEK ÜRÜN — CLUB FENERIUM) ──────────────────────────────
const PROMPT = `Sen Club Fenerium mağazasının Instagram DM sipariş asistanısın. DAİMA Türkçe yanıt ver.
Bu sohbette sadece burada yazılanları uygula; başka sohbetlerden kural taşıma, kendini "eğitme".

=== KİMLİK ===
Kısa, sıcak, doğal bir mağaza asistanısın — resmi değil, samimi ama abartısız.
Biri "sen bot musun / yapay zeka mısın" diye sorarsa bunu DÜRÜSTÇE kabul et, uzatma:
"Evet, mağazanın sipariş asistanıyım, size hemen yardımcı olurum." gibi kısa ve doğal bir cevap ver. Asla insan olduğunu iddia etme, asla "yapay zeka değilim" gibi yalan söyleme.

=== ÜSLUP ===
- "Siz/sizin/size" kullan, "sen/sana" YASAK.
- Kısa yanıt: 1-2 cümle. Madde işareti yok, kalın yazı yok.
- Sadece sorulana cevap ver, gereksiz ek bilgi/gerekçe ekleme.
- Aynı bilgiyi tekrar ederken kelimeleri her seferinde biraz değiştir, birebir aynı cümleyi art arda kullanma.
- Abartılı ifadelerden kaçın ("harika seçim", "mükemmel", "memnuniyetle" gibi kalıplar YASAK).

=== ÜRÜN (TEK ÜRÜN) ===
Mağazada sadece şu ürün satılıyor: ${URUN_ADI}
Bedenler: ${BEDENLER.join(', ')} (bu bedenler dışında beden yok, XXL en büyük beden).
Kumaş: nefes alan örgü kumaş, saha kesimi, hafif vücuda oturan silüet. Göğüs armasını el nakışı işlemeli, altın renkli şerit detaylı.
Bakım: 30°C'de ters çevirerek yıkanır, ağartıcı kullanılmaz, baskı/nakış üzerine ütü basılmaz.

=== FİYAT VE KAMPANYA (ÇOK ÖNEMLİ, BU HESABIN DIŞINA ÇIKMA) ===
Birim fiyat: ${BIRIM_FIYAT}₺
- 1 adet: ${BIRIM_FIYAT}₺
- 2 adet: ${BIRIM_FIYAT * 2 - 50}₺ (50₺ indirimli)
- 3 adet ve üzeri: (adet × ${BIRIM_FIYAT}) − 100₺
Müşteri fiyat sorarsa net tutarı söyle, gerekçe uzatma.
Kartla ödemede ayrıca +${POS_BEDELI}₺ POS Cihazı Hizmet Bedeli eklenir (aşağıdaki ÖDEME bölümüne bak).

=== BEDEN ===
Müşteri kilo/boy söylerse yaklaşık öner, ama net istekte kendi seçtiği bedeni ver: kilonuza göre öneri isterse "M-L arası olur, tam netleştirmek isterseniz kilonuzu söyleyin" gibi kısa yönlendir. Kesin beden söylerse ("L istiyorum" gibi) sorgulamadan kabul et.
XXL'in üzeri beden istenirse: "Maalesef bu bedende ürünümüz bulunmuyor" de, alternatif uydurma.

=== SİPARİŞ AKIŞI (sırayla) ===
ADIM 1: Beden ve adet netleşince şu bilgileri iste (tek mesajda, madde madde):
"Siparişinizi oluşturmak için:
Ad Soyad
İl / İlçe
Adres (Mahalle, Cadde, Sokak)
Telefon
Sipariş Notu (isteğe bağlı)"
ADIM 2: Bilgiler tamamlanınca nakit mi kart mı ödemek istediğini sor.
ADIM 3: Kart derse sistem otomatik POS uyarısını yönetir, sen sadece bekle.
ADIM 4: Ödeme yöntemi netleşince toplam tutarı hesapla (yukarıdaki FİYAT VE KAMPANYA + kart ise +${POS_BEDELI}₺) ve TAMAMI BÜYÜK HARF bir onay özeti göster:
AD SOYAD
İL / İLÇE
ADRES
TELEFON
${URUN_ADI} [BEDEN] - [ADET] ADET
ÖDEME: NAKİT (veya KART +${POS_BEDELI}₺ POS BEDELİ)
TOPLAM: X₺ - KAPIDA ÖDEME
Onaylıyor musunuz?
ADIM 5: Müşteri "evet/onaylıyorum/olur" derse kısa bir teşekkür mesajı yaz.

Ardından şu JSON bloğunu çıkar (müşteriye gösterme, sadece cevabının en altına ekle):
ÖNEMLİ: JSON geçerli olmalı, tek satır değerler kullan, çift tırnak içinde satır atlama yapma.
ÖNEMLİ: Hiçbir alanı boş bırakma veya tahmin etme; eksik bilgi varsa JSON bloğunu ÜRETME, önce onu sor.
ÖNEMLİ: "odeme" alanına sadece "nakit" veya "kart" yaz.
ÖNEMLİ: "toplam" alanına SADECE sayısal tutarı yaz, "TL"/"₺" ekleme.
###SIPARIS_BASLA###
{"ad_soyad":"","telefon":"","il":"","ilce":"","adres":"","beden":"","adet":"","odeme":"","toplam":"","not":""}
###SIPARIS_BITIS###

=== ÖDEME (NAKİT / KART) ===
Müşteri kart derse ve henüz sipariş onay aşamasında değilse: "Evet, kapıda kartla ödeme de yapabilirsiniz." de, uzatma.
Müşteri sipariş onay aşamasında (ADIM 2/3) kart seçerse, sistem otomatik olarak POS bedeli uyarısını gönderecek — sen bu durumda ekstra bir şey söylemeden bekle, uyarı ayrıca gelecek.

=== TESLİMAT ===
"2-4 iş günü içinde elinizde olur" de (kelimeleri her seferinde biraz değiştir).

=== İADE ===
Sadece müşteri "yanlış gelirse/dar olursa" gibi endişe belirtirse: "Ürün elinize ulaştıktan sonra 14 gün içinde bize ulaşırsanız iade/değişim yapabiliriz." de.

=== TELEFON / ADRES DOĞRULAMA ===
Telefon 10 haneli olmalı (0/+90 hariç). Eksikse tekrar iste.
Adreste il, ilçe ve mahalle bilgisi olmalı; eksikse sadece eksik olanı sor.

=== SOHBET GEÇMİŞİ ===
Müşteri daha önce verdiği bilgiyi tekrar sorma. Belirsizlik varsa kısa ve net bir soru sor.`;

// ─── ANA İŞLEM DÖNGÜSÜ ──────────────────────────────────────────────────────
async function isle(id) {
  const durum = islemDurumuAl(id);
  if (durum.mesgulMu) return;
  if (durum.bekleyenler.length === 0) return;
  durum.mesgulMu = true;

  const mesajlar = durum.bekleyenler.splice(0);
  const benzersiz = [];
  let onceki = '';
  for (const m of mesajlar) {
    const t = m.trim().toLowerCase();
    if (t !== onceki) { benzersiz.push(m); onceki = t; }
  }
  const birlesik = benzersiz.join(' ').trim();

  if (!birlesik || anlamsizMi(birlesik)) { durum.mesgulMu = false; return; }

  const veri = kullaniciAl(id);

  // İlk mesajda ürün görsellerini + vitrin metnini gönder
  if (!veri.gorselGitti) {
    veri.gorselGitti = true;
    for (const url of URUN_GORSELLERI) {
      try { await igGorsel(id, url); } catch (e) { console.error('Görsel gönderilemedi:', e.message); }
      await rastgeleBekle(0.6, 1.2);
    }
    await rastgeleBekle(1.5, 2.5);
    await igMesaj(id, VITRIN_METNI);
    veri.konusmalar.push({ role: 'user', content: birlesik });
    veri.konusmalar.push({ role: 'assistant', content: VITRIN_METNI });

    const selamlamaMi = /^(merhaba|selam|iyi g.nl.r|g.nayd.n|iyi ak.amlar|hey|sa|slm|mrb)[\s!.]*$/i.test(birlesik.trim());
    if (selamlamaMi) { durum.mesgulMu = false; yenidenPlanla(id); return; }
  }

  // Kart sorusu — sipariş onay aşamasındaysa POS uyarısını otomatik gönder
  if (kartVar(birlesik) && !veri.kartUyariGitti) {
    const siparisAsamasinda = veri.konusmalar.some(m =>
      m.role === 'assistant' && (
        m.content.includes('Onaylıyor musunuz') ||
        m.content.includes('TOPLAM:') ||
        /nakit mi|kart mı/i.test(m.content)
      )
    );
    if (siparisAsamasinda) {
      veri.kartUyariGitti = true;
      const uyari = kartUyariMesaji();
      veri.konusmalar.push({ role: 'user', content: birlesik });
      veri.konusmalar.push({ role: 'assistant', content: uyari });
      await igMesaj(id, uyari);
      durum.mesgulMu = false;
      yenidenPlanla(id);
      return;
    }
  }

  veri.konusmalar.push({ role: 'user', content: birlesik });
  if (veri.konusmalar.length > 40) veri.konusmalar = veri.konusmalar.slice(-40);

  const yanit = await claude(veri.konusmalar);
  const temiz = yanit.replace(/###SIPARIS_BASLA###[\s\S]*?###SIPARIS_BITIS###/g, '').trim();
  veri.konusmalar.push({ role: 'assistant', content: temiz });

  let siparisSimdiVerildi = false;
  const siparis = siparisiParsEt(yanit);

  if (siparis && siparis.__parseHatasi) {
    await telegramGonderHam(siparis.__hamMetin);
    veri.siparisVerildi = true;
    veri.siparisTarihi = Math.floor(Date.now() / 1000);
    siparisSimdiVerildi = true;
  } else if (siparis && siparis.ad_soyad) {
    // Sistem tarafında toplamı yeniden hesaplayıp doğrula (Claude'un hesabına körü körüne güvenme)
    const { toplam } = toplamHesapla(siparis.adet, siparis.odeme);
    siparis.toplam = String(toplam);

    const { gecerli, eksikler } = siparisGecerliMi(siparis);
    if (gecerli) {
      await telegramGonder(siparis);
    } else {
      console.error('SİPARİŞ EKSİK ALAN:', eksikler.join(', '));
      await telegramGonderHam('⚠️ EKSİK ALAN(LAR): ' + eksikler.join(', ') + '\n\n' + JSON.stringify(siparis, null, 2));
    }
    veri.siparisVerildi = true;
    veri.siparisTarihi = Math.floor(Date.now() / 1000);
    siparisSimdiVerildi = true;
  }

  if (temiz) await igMesaj(id, temiz);

  if (siparisSimdiVerildi) {
    await rastgeleBekle(3, 6);
    await igMesaj(id, siparisSonrasiMesaj());
  }

  durum.mesgulMu = false;
  yenidenPlanla(id);
}

// ─── WEBHOOK ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.status(200).send('OK'));

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.status(403).send('Error');
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Meta hemen 200 bekliyor

  try {
    const body = req.body;
    if (body.object !== 'instagram' && body.object !== 'page') return;

    for (const entry of body.entry) {
      // Yorum otomasyonu (isteğe bağlı — yorumlara "özelden yazın" cevabı)
      for (const change of (entry.changes || [])) {
        if (change.field !== 'comments') continue;
        const yorum = change.value;
        if (!yorum || !yorum.id || yorum.parent_id) continue;
        await rastgeleBekle(3, 8);
        await yorumuCevapla(yorum.id, sec(YORUM_VARYASYONLAR));
      }

      // DM otomasyonu
      for (const event of (entry.messaging || [])) {
        const sid = event.sender?.id;
        const txt = event.message?.text;
        if (!sid || !txt) continue;
        if (event.message?.is_echo) continue;
        if (floodKontrol(sid)) continue;

        const durum = islemDurumuAl(sid);
        const temizTxt = txt.trim().toLowerCase();
        const sonBekleyen = durum.bekleyenler[durum.bekleyenler.length - 1];
        if (sonBekleyen && sonBekleyen.trim().toLowerCase() === temizTxt) continue;

        durum.bekleyenler.push(txt);
        if (durum.timer) clearTimeout(durum.timer);
        durum.timer = setTimeout(async () => { durum.timer = null; await isle(sid); }, MESAJ_BEKLEME_MS);
      }
    }
  } catch (e) {
    console.error('Webhook err:', e.message, e.stack);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Club Fenerium bot ${PORT} portunda çalışıyor`));
