/**
 * The red team of S8.3 AC3, across countries and scripts (GL-03b).
 *
 * `filter.test.ts` holds the original ten ways out, written around one Thai owner. A worldwide alpha is used by
 * people whose names are in Cyrillic, Arabic, Hebrew, Devanagari, Han, Hangul, Greek and accented Latin, whose
 * identity numbers are not Thai, and whose digits are not always 0-9. These are the same kind of test: what the
 * text filter catches, and — written down as plainly — what it does not, so that the day one of those is caught,
 * or a caught one slips, a test changes colour instead of a sentence going stale.
 *
 * Shared by `red-team.test.ts` (the filter, always run) and `judge.real.test.ts` (the filter and then a model on
 * this machine, opt-in): the forms the filter cannot see are exactly the ones the judge is for.
 *
 * Every person, number and company here is invented, or is a published specimen (an ICAO 9303 sample, a national
 * issuer's own example); none is a real person's.
 */

/** What the owner has said must not leave: names in many scripts, a business, an illness. The first three are the original lexicon. */
export const WORLD_LEXICON = {
  needles: [
    "Wanida Srisuk",
    "ร้านใบเตยหอม",
    "stage 2 diabetes",
    "Анастасия Волкова",
    "José Ñandú Gutiérrez",
    "Nguyễn Thị Hương",
    "أحمد المنصوري",
    "יעל כהן",
    "田中太郎",
    "김민준",
    "王小明",
    "प्रिया शर्मा",
    "Ελένη Παπαδοπούλου",
    "Müller & Söhne GmbH",
  ],
};

/** One way out: where it is from, what it is, the text, and the rule that stops it (`needle`, or a shape's name). */
export interface Form {
  readonly country: string;
  readonly form: string;
  readonly text: string;
  readonly rule: string;
}

/** Stopped by the filter. */
export const WORLD_CAUGHT: readonly Form[] = [
  // The owner's own words, in every script.
  { country: "ru", form: "a needle in Cyrillic, in a sentence", text: "Спасибо, Анастасия Волкова, мы всё получили.", rule: "needle" },
  { country: "ru", form: "a needle in Cyrillic capitals", text: "АНАСТАСИЯ ВОЛКОВА ЖДЁТ ОТВЕТА", rule: "needle" },
  { country: "es", form: "a needle with its accents written as base letter plus mark", text: "Envíe la carta a José Ñandú Gutiérrez mañana", rule: "needle" },
  { country: "vn", form: "a needle with stacked tone marks, written as the one precomposed letters", text: "Chị Nguyễn Thị Hương hẹn gặp lúc 9 giờ", rule: "needle" },
  { country: "vn", form: "the same needle with every mark written apart", text: "Chị Nguyễn Thị Hương hẹn gặp", rule: "needle" },
  { country: "ae", form: "a needle in Arabic", text: "تواصل مع أحمد المنصوري بخصوص الفاتورة", rule: "needle" },
  { country: "il", form: "a needle in Hebrew", text: "פגישה עם יעל כהן ביום ראשון", rule: "needle" },
  { country: "jp", form: "a needle in Japanese", text: "田中太郎様、請求書をお送りします。", rule: "needle" },
  { country: "kr", form: "a needle in Korean", text: "김민준 님께 연락 부탁드립니다.", rule: "needle" },
  { country: "cn", form: "a needle in Chinese", text: "请联系王小明确认合同。", rule: "needle" },
  { country: "in", form: "a needle in Devanagari", text: "प्रिया शर्मा को ईमेल भेजें।", rule: "needle" },
  { country: "gr", form: "a needle in Greek", text: "Στείλτε το αρχείο στην Ελένη Παπαδοπούλου", rule: "needle" },
  { country: "de", form: "a company with umlauts and an ampersand, in capitals", text: "Rechnung an MÜLLER & SÖHNE GMBH, Berlin", rule: "needle" },
  { country: "th", form: "a shop's name inside a Thai sentence", text: "ติดต่อร้านใบเตยหอมก่อนวันที่ 26", rule: "needle" },
  { country: "any", form: "a needle inside a JSON line", text: '{"owner":"Анастасия Волкова","plan":"pro"}', rule: "needle" },
  { country: "any", form: "a needle typed in full-width letters", text: "ＷＡＮＩＤＡ　ＳＲＩＳＵＫ asked for the invoice", rule: "needle" },
  { country: "any", form: "a needle with zero-width characters slipped into it", text: "Wan​ida Sri‌suk", rule: "needle" },
  { country: "any", form: "a needle with a soft hyphen and bidirectional marks in it", text: "Wani­da Sri‪suk‬", rule: "needle" },

  // Numbers that have a shape, each written the way people of that country write them.
  { country: "us", form: "a social security number on a form", text: "Employee SSN: 123-45-6789 (W-4 attached)", rule: "us-ssn" },
  { country: "gb", form: "a National Insurance number in a payroll line", text: "Payroll: J. Smith, NI JG 10 33 11 B, 2,150.00", rule: "uk-nino" },
  { country: "de", form: "an IBAN in an instruction to pay", text: "Bitte überweisen Sie 480 EUR an DE89 3704 0044 0532 0130 00 bis Freitag.", rule: "iban" },
  { country: "fr", form: "a social security number, grouped", text: "Mon numéro de sécu : 2 55 08 14 168 025 38", rule: "fr-insee" },
  { country: "es", form: "a DNI in a sentence", text: "Mi DNI es 12345678Z, gracias.", rule: "es-dni" },
  { country: "it", form: "a codice fiscale", text: "Il mio codice fiscale è RSSMRA85T10A562S.", rule: "it-codice-fiscale" },
  { country: "br", form: "a CPF", text: "Meu CPF é 529.982.247-25, obrigado.", rule: "br-cpf" },
  { country: "br", form: "a phone number with the country code", text: "Meu telefone é +55 11 91234-5678.", rule: "phone-e164" },
  { country: "mx", form: "a CURP", text: "Mi CURP es HEGG560427MVZRRL04.", rule: "mx-curp" },
  { country: "cn", form: "a resident identity card number", text: "身份证号：11010519491231002X", rule: "cn-resident-id" },
  { country: "jp", form: "a phone number in a Japanese sentence", text: "お電話は+81 90 1234 5678までお願いします。", rule: "phone-e164" },
  { country: "jp", form: "a passport number after the word for passport", text: "パスポート番号 TK1234567 有効期限 2030年", rule: "passport-number" },
  { country: "kr", form: "a resident registration number", text: "주민등록번호는 900101-1234567 입니다.", rule: "kr-resident-number" },
  { country: "tw", form: "a national ID", text: "身分證字號 A123456789", rule: "tw-national-id" },
  { country: "in", form: "an Aadhaar number in a Hindi sentence", text: "मेरा आधार नंबर 2345 6789 0124 है।", rule: "in-aadhaar" },
  { country: "ru", form: "a SNILS in a Russian sentence", text: "Мой СНИЛС 112-233-445 95, пришлите справку.", rule: "ru-snils" },
  { country: "sg", form: "an NRIC", text: "Visitor NRIC S1234567D, level 12.", rule: "sg-nric" },
  { country: "se", form: "a personnummer", text: "Personnummer: 811218-9876", rule: "se-personnummer" },
  { country: "ae", form: "a phone number written with Arabic-Indic digits", text: "اتصل بي على +٩٧١ ٥٠ ١٢٣ ٤٥٦٧ مساءً", rule: "phone-e164" },
  { country: "ae", form: "a card number written with Arabic-Indic digits", text: "رقم البطاقة ٤١١١ ١١١١ ١١١١ ١١١١", rule: "payment-card" },
  { country: "th", form: "a phone number written with Thai digits", text: "โทร ๐๘๑-๒๓๔-๕๖๗๘ หลังหกโมง", rule: "thai-phone" },
  { country: "any", form: "a pasted machine-readable zone", text: "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10", rule: "passport-mrz" },
  { country: "any", form: "a card number in full-width digits", text: "card ４１１１ １１１１ １１１１ １１１１", rule: "payment-card" },
];

/**
 * What the filter does not stop, and why.
 *
 * `by: "judge"` — the form is one of the owner's needles in another dress, which the local model (D-061) reads for.
 * `by: "needle"` — the form is personal data with no needle behind it and no shape for it here: nothing reads it,
 * and the owner's remedy is the one the filter says plainly, to list it as a needle (`needle` is what to list).
 */
export interface Miss {
  readonly country: string;
  readonly form: string;
  readonly text: string;
  readonly why: string;
  readonly by: "judge" | "needle";
  readonly needle?: string;
}

export const WORLD_MISSED: readonly Miss[] = [
  { country: "any", form: "a Cyrillic needle written in Latin letters", text: "Please call Anastasia Volkova tomorrow", why: "transliteration: the filter matches text, not sound", by: "judge" },
  { country: "any", form: "a Latin needle written in Cyrillic letters", text: "Позвоните Ванида Шрисук завтра", why: "transliteration the other way", by: "judge" },
  { country: "any", form: "an illness said in another language", text: "Ella lleva una diabetes mellitus tipo dos en fase avanzada", why: "translation: no pattern, no needle", by: "judge" },
  { country: "any", form: "a Latin needle with look-alike letters of another script", text: "W\u0430nid\u0430 Srisuk asked for the invoice", why: "homoglyphs: Cyrillic а is not Latin a", by: "judge" },
  { country: "any", form: "a paraphrase", text: "The bookkeeper whose first name means 'young woman' in Sanskrit runs the bakery's accounts.", why: "paraphrase has no pattern", by: "judge" },
  { country: "any", form: "a phone number written in words", text: "call oh eight one, two three four, five six seven eight", why: "a number written in words has no digits to check", by: "needle", needle: "oh eight one" },
  { country: "nl", form: "an identity number the list has no shape for (a Dutch BSN)", text: "mijn BSN is 111222333", why: "nine bare digits are anything", by: "needle", needle: "111222333" },
  { country: "tr", form: "an identity number the list has no shape for (a Turkish T.C. kimlik no)", text: "TC kimlik no: 10000000146", why: "eleven bare digits are anything", by: "needle", needle: "10000000146" },
  { country: "jp", form: "an identity number the list has no shape for (a My Number)", text: "マイナンバーは 1234 5678 9018 です", why: "no shape for it here", by: "needle", needle: "1234 5678 9018" },
];

/** Work that must still leave, in the languages of the people doing it. */
export const WORLD_ORDINARY: readonly string[] = [
  "close the books on the 26th and reconcile the bank feed",
  "refactor the parser so it reads fences in pairs",
  "Ask Somchai in accounting to send the invoice template.",
  "Summarise yesterday's server logs and list any service that restarted.",
  "Закройте квартал до 26-го числа и сверьте банковскую выписку.",
  "请把第三季度的报表在10月13日之前发给财务部，分机8801。",
  "10月13日までに第3四半期の報告書を経理部に送ってください。",
  "10월 13일까지 3분기 보고서를 재무팀에 보내 주세요.",
  "يرجى إرسال تقرير الربع الثالث إلى قسم المالية قبل ١٣ أكتوبر.",
  "कृपया तीसरी तिमाही की रिपोर्ट 13 अक्टूबर तक वित्त विभाग को भेजें।",
  "Bitte schicken Sie den Quartalsbericht bis zum 13. Oktober an die Buchhaltung.",
  "Por favor, envíe el informe del tercer trimestre antes del 13 de octubre.",
  "Veuillez envoyer le rapport du troisième trimestre avant le 13 octobre.",
  "กรุณาส่งรายงานไตรมาสที่ 3 ให้ฝ่ายบัญชีก่อนวันที่ 13 ตุลาคม",
];
