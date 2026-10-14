/**
 * GL-03b — the personal-data shapes that are not Thai (`src/egress/shapes.ts`, listed by `FILTER_SHAPES`).
 *
 * Every rule has a test of what it catches **and** a test of what it must let through: a near miss with a wrong
 * check digit, a number in a range its issuer never assigns, a number inside a longer one, and the bare digits
 * a pattern with no separators would take for anything. A filter that fires on ordinary work is one nobody
 * keeps switched on, so the last describe runs a corpus of ordinary text — many languages, many numbers — and
 * expects nothing.
 *
 * The positives are published sample numbers or numbers built here from the issuer's own rule, restated in this
 * file rather than imported, so the check is not the code checking itself.
 */

import { describe, expect, test } from "bun:test";
import { FILTER_LIMITS, FILTER_SHAPES, describeFindings, screen } from "../../src/egress/filter.ts";
import { forShapes, ibanValid, luhn, mrzCheck, verhoeff } from "../../src/egress/shapes.ts";

const rules = (text: string): string[] => screen(text, { needles: [] }).map((f) => f.rule);

/** Every text is caught by `rule`, and not one of the others is caught by it. */
function catches(rule: string, positives: readonly string[]): void {
  for (const text of positives) expect(rules(text), `${rule}: ${text}`).toContain(rule);
}
function passes(rule: string, negatives: readonly string[]): void {
  for (const text of negatives) expect(rules(text), `${rule} must not fire: ${text}`).not.toContain(rule);
}

// ---------------------------------------------------------------------------------------------------------------
// The issuers' rules, restated, to build numbers that are right (and numbers that are one digit wrong)
// ---------------------------------------------------------------------------------------------------------------

const luhnDigit = (body: string): string => {
  for (let d = 0; d < 10; d += 1) if (luhn(`${body}${d}`)) return String(d);
  throw new Error("no luhn digit");
};

const verhoeffDigit = (body: string): string => {
  for (let d = 0; d < 10; d += 1) if (verhoeff(`${body}${d}`)) return String(d);
  throw new Error("no verhoeff digit");
};

const cnCheck = (body: string): string => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  return "10X98765432"[[...body].reduce((t, d, i) => t + Number(d) * weights[i]!, 0) % 11]!;
};

const dniLetter = (digits: string): string => "TRWAGMYFPDXBNJZSQVHLCKE"[Number(digits) % 23]!;

const inseeKey = (body13: string): string => String(97 - (Number(body13) % 97)).padStart(2, "0");

const wrong = (digit: string): string => String((Number(digit) + 1) % 10);
const breakLast = (text: string): string => `${text.slice(0, -1)}${wrong(text.slice(-1))}`;

describe("digits of any script, and the compatibility forms (forShapes)", () => {
  test("every decimal digit of every script reads as 0-9", () => {
    for (const ten of ["٠١٢٣٤٥٦٧٨٩", "۰۱۲۳۴۵۶۷۸۹", "०१२३४५६७८९", "০১২৩৪৫৬৭৮৯", "๐๑๒๓๔๕๖๗๘๙", "０１２３４５６７８９", "𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗", "௦௧௨௩௪௫௬௭௮௯"]) {
      expect(forShapes(ten), ten).toBe("0123456789");
    }
  });

  test("full-width plus and at-sign fold to the plain ones; plain ASCII is returned untouched", () => {
    expect(forShapes("＋４４　２０")).toBe("+44 20");
    expect(forShapes("ｗ＠ｅｘ．ｃｏ")).toBe("w@ex.co");
    const ascii = "port 30600 and +66 81 234 5678";
    expect(forShapes(ascii)).toBe(ascii);
  });

  test("letters of other scripts are left alone", () => {
    expect(forShapes("Анастасия 14 田中 ๑๒")).toBe("Анастасия 14 田中 12");
  });

  test("a number typed in another script is caught as the number it is", () => {
    expect(rules("٤١١١ ١١١١ ١١١١ ١١١١")).toContain("payment-card");
    expect(rules("４１１１－１１１１－１１１１－１１１１")).toContain("payment-card"); // the full-width hyphen is a hyphen once folded
    expect(rules("４１１１ １１１１ １１１１ １１１１")).toContain("payment-card");
    expect(rules("โทร ๐๘๑-๒๓๔-๕๖๗๘")).toContain("thai-phone");
    expect(rules("+٩٧١ ٤ ١٢٣ ٤٥٦٧")).toContain("phone-e164");
    expect(rules("ＡＢ１２３４５６Ｃ")).toContain("uk-nino");
  });
});

describe("phone numbers with a country code (phone-e164)", () => {
  test("caught: assigned codes, any separators, any length from 8 to 15 digits", () => {
    catches("phone-e164", [
      "call +44 20 7946 0958 after six",
      "+44 (0)20 7946 0958",
      "+1 (415) 555-2671",
      "+14155552671",
      "+81-3-1234-5678",
      "+91 98765 43210",
      "+49 30 901820",
      "+7 495 123-45-67",
      "+55 11 91234-5678",
      "+86 138 0013 8000",
      "+234 802 123 4567",
      "+971 4 123 4567",
      "+353 1 234 5678",
      "tel:+33142685300",
      "+27 21 123 4567",
      "+66 81 234 5678",
      "+886 2 2345 6789",
      "+82 2 312 3456",
      "+380 44 123 4567",
      "+358 40 123 4567",
    ]);
  });

  test("caught in the middle of text in other scripts", () => {
    catches("phone-e164", [
      "اتصل بي على +971 50 123 4567 مساءً",
      "電話は+81 90 1234 5678までお願いします",
      "연락처: +82 10 1234 5678 입니다",
      "звоните +7 912 345-67-89 после шести",
      "संपर्क +91 98765 43210 पर करें",
    ]);
  });

  test("passes: no such country code, a number the plan cannot have, too short, too long, inside a word", () => {
    passes("phone-e164", [
      "+999 123 456 789",
      "+0 123 456 7890",
      "+1 123 456 7890", // a North American area code does not start with 1
      "+1 415 155 2671", // nor does an exchange
      "+7 495 123-45-6", // +7 is eleven digits
      "+44 1234",
      "+4412345678901234567",
      "x+442079460958",
      "442079460958",
      "call +1 for help",
      "+25 C, altitude +1500, delta +30600",
      "2026-10-13 09:30:00 +0700 INFO started",
    ]);
  });
});

describe("North American numbers with their separators (phone-nanp)", () => {
  test("caught", () => {
    catches("phone-nanp", ["(415) 555-2671", "415-555-2671", "415.555.2671", "415 555 2671", "1-415-555-2671", "call 800-555-0199 today", "+1 415 555 2671"]);
  });
  test("passes: ten bare digits, an area code or exchange that cannot be one, a longer number", () => {
    passes("phone-nanp", ["4155552671", "123-456-7890", "415-155-2671", "415 555 267", "415-555-26711", "415-555-2671-9", "2026-10-13", "192.168.100.100"]);
  });
});

describe("IBAN (iban)", () => {
  const SAMPLES = [
    "GB82 WEST 1234 5698 7654 32",
    "DE89 3704 0044 0532 0130 00",
    "FR14 2004 1010 0505 0001 3M02 606",
    "NL91 ABNA 0417 1643 00",
    "ES91 2100 0418 4502 0005 1332",
    "IT60 X054 2811 1010 0000 0123 456",
    "CH93 0076 2011 6238 5295 7",
    "SE45 5000 0000 0583 9825 7466",
    "NO93 8601 1117 947",
    "PL61 1090 1014 0000 0712 1981 2874",
    "BR18 0036 0305 0000 1000 9795 493C 1",
    "AE07 0331 2345 6789 0123 456",
    "SA03 8000 0000 6080 1016 7519",
    "TR33 0006 1005 1978 6457 8413 26",
    "BE68 5390 0754 7034",
    "AT61 1904 3002 3457 3201",
    "DK50 0040 0440 1162 43",
    "FI21 1234 5600 0007 85",
    "IE29 AIBK 9311 5212 3456 78",
    "LU28 0019 4006 4475 0000",
    "PT50 0002 0123 1234 5678 9015 4",
    "GR16 0110 1250 0000 0001 2300 695",
    "HU42 1177 3016 1111 1018 0000 0000",
    "CZ65 0800 0000 1920 0014 5399",
  ];

  test("every published sample is valid under mod 97, and is caught spaced, compact, hyphenated and in lower case", () => {
    for (const sample of SAMPLES) {
      const compact = sample.replace(/ /g, "");
      expect(ibanValid(compact), sample).toBe(true);
      catches("iban", [sample, compact, `pay to ${sample} by Friday`, sample.replace(/ /g, "-"), compact.toLowerCase()]);
    }
  });

  test("caught in other scripts' sentences, and in full-width characters", () => {
    catches("iban", [
      "Überweisen Sie bitte an DE89 3704 0044 0532 0130 00 bis Freitag.",
      "请汇款至 GB82 WEST 1234 5698 7654 32 谢谢",
      "Перечислите на FR14 2004 1010 0505 0001 3M02 606 до пятницы",
      "ＧＢ８２　ＷＥＳＴ　１２３４　５６９８　７６５４　３２",
    ]);
  });

  test("passes: a wrong check digit, a wrong length, a country that has no IBAN, glued to a longer token, words after it", () => {
    passes("iban", [
      "GB83 WEST 1234 5698 7654 32",
      "GB82 WEST 1234 5698 7654 3",
      "GB82 WEST 1234 5698 7654 321",
      "XX82 WEST 1234 5698 7654 32",
      "xGB82WEST12345698765432",
      "GB82WEST12345698765432x",
      "DE89 3704 0044 0532 0130 01",
      "AB12 is a part code and CD34 another",
    ]);
  });

  test("the words that follow an IBAN are not taken for part of it", () => {
    catches("iban", ["DE89 3704 0044 0532 0130 00 is the account for the rent this month"]);
  });
});

describe("US social security number (us-ssn)", () => {
  test("caught, with hyphens or spaces", () => {
    catches("us-ssn", ["123-45-6789", "078-05-1120", "SSN: 219-09-9999", "123 45 6789", "her number is 457-55-5462, please", "社会保障番号は123-45-6789です"]);
  });
  test("passes: ranges never issued, bare digits, other shapes of digits, longer numbers", () => {
    passes("us-ssn", [
      "000-12-3456",
      "666-12-3456",
      "900-12-3456",
      "999-99-9999",
      "123-00-4567",
      "123-45-0000",
      "123456789",
      "123-456-7890",
      "2026-10-13",
      "12-345-6789",
      "123-45-67890",
      "1234-56-7890",
      "ref-123-45-6789",
    ]);
  });
});

describe("UK National Insurance number (uk-nino)", () => {
  test("caught, spaced or not, in either case", () => {
    catches("uk-nino", ["AB123456C", "AB 12 34 56 C", "ab123456c", "JG 10 33 11 B", "NI number: PX 12 34 56 D", "Her NINO is CE123456A."]);
  });
  test("passes: letters never used, prefixes never issued, a suffix beyond D, wrong digit counts", () => {
    passes("uk-nino", [
      "QQ123456C",
      "DA123456C",
      "FA123456C",
      "IA123456C",
      "UA123456C",
      "VA123456C",
      "AD123456C",
      "AO123456C",
      "BG123456C",
      "GB123456C",
      "NK123456C",
      "KN123456C",
      "TN123456C",
      "NT123456C",
      "ZZ123456C",
      "AB123456E",
      "AB12345C",
      "AB1234567C",
      "xAB123456C",
    ]);
  });
});

describe("Chinese resident identity card (cn-resident-id)", () => {
  const BODIES = ["11010519491231002", "44030019900101123", "31010119851102331", "51010620000229004", "11010119780515123"];
  test("caught: the published sample, and numbers built with the MOD 11-2 rule", () => {
    catches("cn-resident-id", ["11010519491231002X", ...BODIES.map((body) => `${body}${cnCheck(body)}`), `身份证号：${BODIES[1]}${cnCheck(BODIES[1]!)}。`]);
  });
  test("passes: a wrong check character, a month 13, a day that is not on the calendar, a year out of range, a longer run", () => {
    const body = BODIES[1]!;
    passes("cn-resident-id", [
      `${body}${wrong(cnCheck(body) === "X" ? "0" : cnCheck(body))}`,
      "11010519491331002X",
      "11010519490230002X",
      "11010517491231002X",
      "01010519491231002X",
      `${body}${cnCheck(body)}1`,
      `x${body}${cnCheck(body)}`,
      "1101051949123100",
    ]);
  });
});

describe("Indian Aadhaar (in-aadhaar)", () => {
  test("the Verhoeff check itself", () => {
    expect(verhoeff("2363")).toBe(true);
    expect(verhoeff("2364")).toBe(false);
    expect(verhoeff("12345")).toBe(false);
  });
  test("caught: three groups of four, spaces or hyphens", () => {
    for (const body of ["23456789012", "98765432109", "50000000000", "21212121212"]) {
      const number = `${body}${verhoeffDigit(body)}`;
      const spaced = `${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)}`;
      catches("in-aadhaar", [spaced, spaced.replace(/ /g, "-"), `आधार संख्या ${spaced} है`]);
    }
  });
  test("passes: a wrong check digit, a first digit 0 or 1, bare digits, a card-shaped run, inside a longer number", () => {
    const good = `2345 6789 012${verhoeffDigit("23456789012")}`;
    passes("in-aadhaar", [
      breakLast(good),
      `0345 6789 012${verhoeffDigit("03456789012")}`,
      `1345 6789 012${verhoeffDigit("13456789012")}`,
      good.replace(/ /g, ""),
      `${good} 1234`,
      `1234 ${good}`,
      "1234 5678 9012",
    ]);
  });
});

describe("Spanish DNI and NIE (es-dni)", () => {
  test("caught", () => {
    const dni = ["12345678", "87654321", "00000001", "49100123"].map((digits) => `${digits}${dniLetter(digits)}`);
    const nie = ["X1234567", "Y1234567", "Z7654321"].map((text) => `${text}${dniLetter(`${"XYZ".indexOf(text[0]!)}${text.slice(1)}`)}`);
    catches("es-dni", [...dni, ...nie, "12345678Z", "X1234567L", `DNI ${dni[0]!.slice(0, 8)}-${dni[0]!.slice(-1)}`, `NIE: ${nie[0]!.slice(0, 1)}-${nie[0]!.slice(1, 8)}-${nie[0]!.slice(-1)}`]);
  });
  test("passes: a wrong letter, seven digits, a letter after it, no leading X/Y/Z", () => {
    passes("es-dni", ["12345678A", "X1234567A", "1234567Z", "12345678ZZ", "A1234567L", "123456789Z"]);
  });
});

describe("Italian codice fiscale (it-codice-fiscale)", () => {
  test("caught", () => {
    catches("it-codice-fiscale", ["RSSMRA85T10A562S", "rssmra85t10a562s", "codice fiscale: RSSMRA85T10A562S.", "Il mio CF è RSSMRA85T10A562S"]);
  });
  test("passes: a wrong check letter, a month letter that does not exist, too short, inside a longer token", () => {
    passes("it-codice-fiscale", ["RSSMRA85T10A562T", "RSSMRA85Z10A562S", "RSSMRA85T10A562", "xRSSMRA85T10A562S", "RSSMRA85T10A562SS"]);
  });
});

describe("Brazilian CPF (br-cpf)", () => {
  test("caught", () => {
    catches("br-cpf", ["529.982.247-25", "111.444.777-35", "CPF: 529.982.247-25.", "meu CPF é 111.444.777-35, ok"]);
  });
  test("passes: wrong check digits, one digit repeated, bare digits, a longer number", () => {
    passes("br-cpf", ["529.982.247-26", "111.444.777-36", "111.111.111-11", "000.000.000-00", "52998224725", "529.982.247-2", "529.982.247-255", "1529.982.247-25"]);
  });
});

describe("Singapore NRIC and FIN (sg-nric)", () => {
  const letter = (series: string, digits: string): string => {
    const sum = [...digits].reduce((t, d, i) => t + Number(d) * [2, 7, 6, 5, 4, 3, 2][i]!, 0) + (series === "T" || series === "G" ? 4 : 0);
    return ("ST".includes(series) ? "JZIHGFEDCBA" : "XWUTRQPNMLK")[sum % 11]!;
  };
  test("caught: S, T, F and G, the check letter built from the published weights", () => {
    const samples = ["S", "T", "F", "G"].flatMap((series) => ["1234567", "0123456", "8765432"].map((digits) => `${series}${digits}${letter(series, digits)}`));
    catches("sg-nric", [...samples, "S1234567D", "F1234567N", "NRIC S1234567D, please"]);
  });
  test("passes: the wrong letter, six digits, another series letter, glued to a word", () => {
    passes("sg-nric", ["S1234567A", "S123456D", "A1234567D", "xS1234567D", "S1234567DD"]);
  });
});

describe("Taiwan national ID (tw-national-id)", () => {
  test("caught", () => {
    catches("tw-national-id", ["A123456789", "身分證字號 A123456789。"]);
    // Built: a letter, 1 or 2, seven digits, and the check digit that makes the weighted sum a multiple of ten.
    const map = "ABCDEFGHJKLMNPQRSTUVXYWZIO";
    for (const letter of ["A", "F", "K", "Z", "M"]) {
      for (const gender of ["1", "2"]) {
        const code = map.indexOf(letter) + 10;
        const head = [Math.floor(code / 10), code % 10, Number(gender), 2, 3, 4, 5, 6, 7, 8];
        const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1];
        const sum = head.reduce((t, d, i) => t + d * weights[i]!, 0);
        const check = (10 - (sum % 10)) % 10;
        catches("tw-national-id", [`${letter}${gender}2345678${check}`]);
      }
    }
  });
  test("passes: a wrong check digit, a gender digit that is not 1 or 2, lower case, glued", () => {
    passes("tw-national-id", ["A123456788", "A323456789", "a123456789", "xA123456789", "A1234567890"]);
  });
});

describe("Korean resident registration number (kr-resident-number)", () => {
  test("caught: a date on the calendar, a first digit 1 to 8, with the hyphen", () => {
    catches("kr-resident-number", ["900101-1234567", "010203-3456789", "000229-4123456", "850515-2123456", "주민등록번호는 900101-1234567 입니다"]);
  });
  test("passes: Feb 30, month 13, a first digit that is not issued, no hyphen, a longer number", () => {
    passes("kr-resident-number", ["850230-1234567", "901301-1234567", "900101-9234567", "900101-0234567", "9001011234567", "1900101-1234567", "900101-12345678"]);
  });
});

describe("French social security number (fr-insee)", () => {
  const wrongKey = (key: string): string => String(Number(key) === 97 ? 1 : Number(key) + 1).padStart(2, "0");
  const spaced = (full: string): string => `${full[0]} ${full.slice(1, 3)} ${full.slice(3, 5)} ${full.slice(5, 7)} ${full.slice(7, 10)} ${full.slice(10, 13)} ${full.slice(13)}`;

  test("caught: the key of 97, grouped or not", () => {
    for (const body of ["1850175120123", "2550814168025", "1991013001234", "1700675001001"]) {
      const full = `${body}${inseeKey(body)}`;
      catches("fr-insee", [full, spaced(full), `n° de sécu ${spaced(full)}.`]);
    }
  });

  test("caught: Corsica writes the department 2A or 2B, which count as 19 and 18 in the key", () => {
    for (const [letters, count] of [["2A", "19"], ["2B", "18"]] as const) {
      const key = inseeKey(`18505${count}120123`);
      catches("fr-insee", [`18505${letters}120123${key}`, `1 85 05 ${letters} 120 123 ${key}`]);
      passes("fr-insee", [`18505${letters}120123${wrongKey(key)}`]);
    }
  });

  test("passes: a wrong key, a month 13, a first digit that is not 1 or 2, a longer number", () => {
    const body = "2550814168025";
    const key = inseeKey(body);
    passes("fr-insee", [
      `${body}${wrongKey(key)}`,
      `2551314168025${inseeKey("2551314168025")}`,
      `3550814168025${inseeKey("3550814168025")}`,
      `${body}${key}1`,
      `x${body}${key}`,
    ]);
  });
});

describe("Swedish personnummer (se-personnummer)", () => {
  test("caught: with or without the century, a plus sign for a centenarian, a coordination number", () => {
    const withCheck = (yymmdd: string, serial: string): string => `${yymmdd}${serial}${luhnDigit(`${yymmdd}${serial}`)}`;
    const a = withCheck("811218", "987");
    catches("se-personnummer", [`${a.slice(0, 6)}-${a.slice(6)}`, `19${a.slice(0, 6)}-${a.slice(6)}`, `811218-9876`, `${a.slice(0, 6)}+${a.slice(6)}`]);
    const coordination = withCheck("811278", "123");
    catches("se-personnummer", [`${coordination.slice(0, 6)}-${coordination.slice(6)}`]);
    const leap = withCheck("000229", "123");
    catches("se-personnummer", [`${leap.slice(0, 6)}-${leap.slice(6)}`]);
  });
  test("passes: a wrong Luhn digit, a month 13, a day 32, no hyphen, a longer number", () => {
    const month13 = `811318-123${luhnDigit("811318123")}`;
    const day32 = `811232-123${luhnDigit("811232123")}`;
    passes("se-personnummer", ["811218-9877", month13, day32, "8112189876", "811218-98765", "1811218-9876"]);
  });
});

describe("Mexican CURP (mx-curp)", () => {
  test("caught", () => {
    catches("mx-curp", ["HEGG560427MVZRRL04", "mi CURP es HEGG560427MVZRRL04."]);
  });
  test("passes: a wrong check digit, a state that does not exist, a month 13, lower case", () => {
    passes("mx-curp", ["HEGG560427MVZRRL05", "HEGG560427MXXRRL04", "HEGG561327MVZRRL04", "hegg560427mvzrrl04"]);
  });
});

describe("Russian SNILS (ru-snils)", () => {
  const control = (number: string): string => {
    const sum = [...number].reduce((t, d, i) => t + Number(d) * (9 - i), 0);
    const value = sum < 100 ? sum : sum > 101 ? sum % 101 : 0;
    return String(value === 100 ? 0 : value).padStart(2, "0");
  };
  test("caught: the published sample and numbers built with the control rule, with a space or a hyphen", () => {
    catches("ru-snils", ["112-233-445 95", "112-233-445-95", "СНИЛС 112-233-445 95"]);
    for (const number of ["123456789", "987654321", "555555555", "100000001"]) {
      catches("ru-snils", [`${number.slice(0, 3)}-${number.slice(3, 6)}-${number.slice(6)} ${control(number)}`]);
    }
  });
  test("passes: a wrong control number, a number below the first issued, the digits alone", () => {
    passes("ru-snils", ["112-233-445 96", "001-001-998 00", "000-000-000 00", "112233445 95", "112-233-445 9"]);
  });
});

describe("the machine-readable zone of a passport or an identity card (passport-mrz)", () => {
  test("the check digit rule: weights 7, 3, 1; letters 10 to 35; < is 0", () => {
    expect(mrzCheck("L898902C3")).toBe(6);
    expect(mrzCheck("740812")).toBe(2);
    expect(mrzCheck("120415")).toBe(9);
    expect(mrzCheck("<<<<<<<<<")).toBe(0);
  });
  test("caught: the ICAO 9303 specimens, a passport's second line and an identity card's", () => {
    catches("passport-mrz", [
      "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
      "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10",
      "7408122F1204159UTO<<<<<<<<<<<6",
      "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<",
    ]);
  });
  test("passes: a date of birth, an expiry or a document number whose check digit is wrong", () => {
    passes("passport-mrz", [
      "L898902C36UTO7408123F1204159ZE184226B<<<<<10",
      "L898902C36UTO7408122F1204158ZE184226B<<<<<10",
      "L898902C37UTO7408122F1204159ZE184226B<<<<<10",
      "7408123F1204159UTO<<<<<<<<<<<6",
      "7408122F1204158UTO<<<<<<<<<<<6",
      "UTO7408122F1204159",
    ]);
  });
});

describe("a passport number written after the word for passport (passport-number)", () => {
  test("caught, in the languages people write it in", () => {
    catches("passport-number", [
      "passport no. AA1234567",
      "Passport: X12345678",
      "my passport number is AB123456",
      "passport number 123456789",
      "PASSPORT NO: GB1234567",
      "passeport n° 123456789",
      "Reisepass AB1234567 gültig bis 2030",
      "pasaporte AB123456",
      "passaporto: YA1234567",
      "паспорт: FA1234567",
      "护照号码 E12345678",
      "パスポート番号 TK1234567",
      "여권번호 M12345678",
      "หนังสือเดินทางเลขที่ AA1234567",
      "جواز سفر رقم A1234567",
      "पासपोर्ट नंबर J1234567",
      "διαβατήριο AB1234567",
      "דרכון 123456789",
    ]);
  });
  test("passes: no word for passport, a number that is not a passport's shape, a number too far from it, an ordinary use of the word", () => {
    passes("passport-number", [
      "AA1234567",
      "Part number AB1234567 ships Tuesday",
      "passport photo size 35 x 45 mm",
      "passport office opens at 0900; passport 2027",
      "passport office 12345678",
      "the passport expires 2027-10-13",
      "boarding pass 123456789 and bus pass AB1234567",
      "passport — the long road home that we took last spring, number AA1234567",
      "passport number AB12345",
    ]);
  });
});

describe("payment cards (payment-card), any issuer, any script's digits", () => {
  test("caught: Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro", () => {
    catches("payment-card", [
      "4111111111111111",
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "5555 5555 5555 4444",
      "3782 822463 10005",
      "6011 1111 1111 1117",
      "3530 1113 3330 0000",
      "3056 9309 0259 04",
      "6200 0000 0000 0005",
      "6759 6498 2643 8453",
      "card ٤١١١ ١١١١ ١١١١ ١١١١",
      "卡号：４１１１ １１１１ １１１１ １１１１",
    ]);
  });
  test("passes: a Luhn failure, one digit repeated, too short, too long", () => {
    passes("payment-card", ["4111 1111 1111 1112", "5555 5555 5555 4445", "0000000000000", "411111111111", "41111111111111111111"]);
  });
});

describe("the shapes as a list", () => {
  test("every rule has a name, a line that says what it catches, and no two share a name", () => {
    const names = FILTER_SHAPES.map((shape) => shape.rule);
    expect(new Set(names).size).toBe(names.length);
    for (const shape of FILTER_SHAPES) {
      expect(shape.rule).toMatch(/^[a-z0-9-]+$/);
      expect(shape.says.length, shape.rule).toBeGreaterThan(10);
    }
  });

  test("the Thai shapes are all still there, and the international ones are named", () => {
    const names = FILTER_SHAPES.map((shape) => shape.rule);
    for (const name of ["email", "thai-phone", "thai-national-id", "payment-card"]) expect(names).toContain(name);
    for (const name of [
      "phone-e164", "phone-nanp", "iban", "us-ssn", "uk-nino", "cn-resident-id", "in-aadhaar", "es-dni", "it-codice-fiscale", "br-cpf",
      "sg-nric", "tw-national-id", "kr-resident-number", "fr-insee", "se-personnummer", "mx-curp", "ru-snils", "passport-mrz", "passport-number",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("a finding names the rule and never the number", () => {
    const findings = screen("her IBAN is GB82 WEST 1234 5698 7654 32 and SSN 123-45-6789", { needles: [] });
    expect(describeFindings(findings)).toBe("iban, us-ssn");
    expect(describeFindings(findings)).not.toMatch(/\d/);
  });

  test("the limits say, plainly, that the shapes supplement the owner's needles and are not the whole of I-6", () => {
    const text = FILTER_LIMITS.join(" ");
    expect(text).toContain("supplement your needles and never replace them");
    expect(text).toContain("no shape here");
    expect(text).toContain("kept in only if it is a needle");
  });
});

describe("ordinary work is not kept in", () => {
  const ORDINARY: readonly string[] = [
    "close the books on the 26th and reconcile the bank feed",
    "2026-09-23 at 14:15, port 30600",
    "Build 1.4.2 (commit f9ae14c) passed in 38 s; coverage 91.3 %.",
    "request id 550e8400-e29b-41d4-a716-446655440000 returned 200 in 38 ms",
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "ip 192.168.1.113 and 10.0.0.1:30701, mac 00:1A:2B:3C:4D:5E",
    "the epoch 1760345678 is 2025-10-13T08:54:38Z",
    "Total: $1,234,567.89 due 13/10/2026; invoice INV-2026-000123",
    "git diff: +12345678 lines, +5%, C++20, x+1234567, 3+4=7",
    "Meeting in room 4021 on level 12, extension 4455, ref A1B2C3D4",
    "version v2.0.0-rc.1, node 22.11.0, bun 1.4.2, python 3.12.4",
    "The year 2026, the number 12345678, pi 3.14159265358979",
    "PO 4500123456 line 10 qty 25 price 199.99",
    "Part number AB1234567 ships Tuesday",
    "ticket ABC-12345 and ENG-2041 are linked; see PR #1234",
    "lat 13.7563, lon 100.5018; elevation 1,500 m",
    "SELECT * FROM t WHERE id IN (1234567890, 2345678901);",
    "0x7ffd5e8a1c40 0x00000000deadbeef",
    "see sections 3.2.1, 3.2.2 and 12.4.10 of the spec",
    "Token usage: 1,204,553 in, 88,102 out",
    "2026-10-13 09:30:00 +0700 INFO worker-12 started",
    "会议定于2026年10月13日下午3点在4号楼201室举行，电话分机8801。",
    "Встреча назначена на 13 октября 2026 года, в кабинете 214, добавочный 8801.",
    "اجتماع يوم ١٣ أكتوبر ٢٠٢٦ في الغرفة ٢١٤",
    "बैठक 13 अक्टूबर 2026 को कमरा 214 में होगी",
    "会議は2026年10月13日、4号館201室で行います。",
    "회의는 2026년 10월 13일 4호관 201호에서 열립니다.",
    "การประชุมวันที่ 13 ตุลาคม 2569 ห้อง 214 ต่อ 8801",
    "ประชุมวันที่ ๑๓ ตุลาคม ๒๕๖๙ ห้อง ๒๑๔",
    "boarding pass 123456789 and bus pass AB1234567",
    "passport photo size 35 x 45 mm; passport office opens at 0900; passport 2027",
    "Phone numbers are formatted like +CC NNN NNN; see E.164.",
    "temperature +25 C, altitude +1500",
    "1234 5678 9012 is not special",
    "Call +1 for help",
  ];

  for (const text of ORDINARY) {
    test(`may leave — ${text.slice(0, 50)}`, () => {
      expect(screen(text, { needles: [] })).toEqual([]);
    });
  }
});

describe("e-mail, found from each @ (email)", () => {
  test("caught: what the pattern always caught", () => {
    catches("email", ["a@b.co", "w.s@example.co.th", "x+y@sub.example.com", "a@b.c", "write to w.s@example.co.th now", "a@b..c", "ｗ＠ｅｘａｍｐｌｅ．ｃｏｍ", "名前: ichiro@例え.jp 宛て ichiro@example.jp"]);
  });
  test("passes: no local part, no dot in the domain, nothing after the dot, a space on either side of the @", () => {
    passes("email", ["@b.co", "a@b", "a@.co", "a@b.", "a @b.co", "a@ b.co", "@", "a@@", "mail me @ noon", "user@localhost"]);
  });
});

describe("a long text is screened in time that follows its length", () => {
  // 50 KB of digits took 0.7 s and a megabyte took minutes while the e-mail pattern was tried from every character
  // of a long run; each case here is a run of the kind a prompt really holds (a number, a base64 blob, minified
  // text) at 400 KB, which that pattern would have taken half a minute for.
  const CASES: readonly [string, string][] = [
    ["a long number", "1234567890".repeat(40_000)],
    ["base64", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(11_000)],
    ["groups of digits", "1234 5678 9012 ".repeat(27_000)],
    ["plus signs and digits", "+1 2 3 4 5 6 7 8 9 ".repeat(21_000)],
    ["at signs", "a@".repeat(200_000)],
    ["a word and a number", "passport 1 ".repeat(36_000)],
    ["Arabic-Indic digits", "٠١٢٣٤٥٦٧٨٩ ".repeat(36_000)],
  ];
  for (const [name, text] of CASES) {
    test(name, () => {
      const started = performance.now();
      screen(text, { needles: ["a needle"] });
      // Seconds are allowed so that a loaded machine does not turn this red; the failure it guards against is minutes.
      expect(performance.now() - started, name).toBeLessThan(8_000);
    }, 30_000);
  }
});
