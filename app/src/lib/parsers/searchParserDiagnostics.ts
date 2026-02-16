export type SearchDiagnosticsInput = {
  totalResults: number;
  blockedMessage: string | null;
};

export type SearchDiagnostics = {
  status: 'ok' | 'empty' | 'blocked';
  hint: string | null;
};

const ZERO_RESULTS_HINT =
  'Результатов нет. Возможные причины: Google блокирует выдачу (captcha/consent), слишком узкие запросы или нет релевантных страниц. Попробуйте VPN, упростите запросы или уберите операторы.';

export function buildSearchDiagnostics(input: SearchDiagnosticsInput): SearchDiagnostics {
  if (input.blockedMessage) {
    return { status: 'blocked', hint: input.blockedMessage };
  }
  if (input.totalResults <= 0) {
    return { status: 'empty', hint: ZERO_RESULTS_HINT };
  }
  return { status: 'ok', hint: null };
}

