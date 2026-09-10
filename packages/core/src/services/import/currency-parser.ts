const CURRENCY_CODES = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
    'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD ' +
    'HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD ' +
    'MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG ' +
    'QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD ' +
    'TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL'
  ).split(' ')
);

export class CurrencyParser {
  removeCurrencySymbols(input: string): string {
    return input
      .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/(?<!\p{L})(?:R|NT|S)\$/giu, '')
      .replace(/\p{Sc}/gu, '')
      .replace(/(?<!\p{L})[A-Za-z]{3}(?!\p{L})/gu, (code) =>
        CURRENCY_CODES.has(code.toUpperCase()) ? '' : code
      )
      .replace(/(?<!\p{L})(?:US|CA|AU|NZ|HK|SG|kr|Fr|Ft|lei|kn|Din)(?!\p{L})\.?/giu, '')
      .replace(/(?:Дин\.|zł|Kč|лв|﷼)/giu, '')
      .trim();
  }

  parseYNABAmountAdvanced(amountStr: string, numberFormat: string): number {
    if (!amountStr || !amountStr.trim()) return 0;

    // Grouping separators vary even within one locale (ordinary, non-breaking,
    // and narrow spaces; straight and curly Swiss apostrophes).
    let amount = this.removeCurrencySymbols(amountStr)
      .replace(/[−－]/g, '-')
      .replace(/[\s'’ʼ]/gu, '');
    let negative = false;
    if (amount.startsWith('(') && amount.endsWith(')')) {
      negative = true;
      amount = amount.slice(1, -1);
    } else if (amount.startsWith('-') || amount.endsWith('-')) {
      negative = true;
      amount = amount.startsWith('-') ? amount.slice(1) : amount.slice(0, -1);
    } else if (amount.startsWith('+')) {
      amount = amount.slice(1);
    }

    const decimalSeparator = this.decimalSeparatorForFormat(numberFormat);
    const value = decimalSeparator
      ? this.parseWithDecimal(amount, decimalSeparator)
      : this.autoDetectAndParse(amount);
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Unable to parse YNAB amount: ${amountStr}`);
    }
    return negative ? -value : value;
  }

  private decimalSeparatorForFormat(format: string): string | undefined {
    const example = this.removeCurrencySymbols(format || '').replace(/[\s'’ʼ]/gu, '');
    const fraction = /([.,/-])(\d{1,3})$/.exec(example);
    if (!fraction) return undefined;
    // A lone separator followed by three digits can be a zero-decimal display
    // preset ("$1,097"). Preserve automatic handling for those existing presets.
    if (fraction[2].length === 3 && !/[.,/-]/.test(example.slice(0, fraction.index))) {
      return undefined;
    }
    return fraction[1];
  }

  private parseWithDecimal(input: string, decimalSeparator: string): number | undefined {
    const parts = input.split(decimalSeparator);
    if (parts.length > 2 || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1]))) {
      return undefined;
    }
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const whole =
      parts.length === 2 && parts[0] === '' ? '0' : this.parseWhole(parts[0], groupingSeparator);
    if (whole === undefined) return undefined;
    const normalized = parts.length === 2 ? `${whole}.${parts[1]}` : whole;
    return Number(normalized);
  }

  private parseWhole(input: string, groupingSeparator: string): string | undefined {
    if (/^\d+$/.test(input)) return input;
    const groups = input.split(groupingSeparator);
    if (groups.length < 2 || !/^\d{1,3}$/.test(groups[0])) return undefined;
    const western = groups.slice(1).every((group) => /^\d{3}$/.test(group));
    const indian =
      groups[0].length <= 2 &&
      /^\d{3}$/.test(groups[groups.length - 1]) &&
      groups.slice(1, -1).every((group) => /^\d{2}$/.test(group));
    return western || indian ? groups.join('') : undefined;
  }

  private autoDetectAndParse(input: string): number | undefined {
    const lastComma = input.lastIndexOf(',');
    const lastDot = input.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      return this.parseWithDecimal(input, lastComma > lastDot ? ',' : '.');
    }
    const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : undefined;
    if (!separator) return /^\d+$/.test(input) ? Number(input) : undefined;
    const parts = input.split(separator);
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) {
      return this.parseWithDecimal(input, separator);
    }
    const whole = this.parseWhole(input, separator);
    return whole === undefined ? undefined : Number(whole);
  }
}
